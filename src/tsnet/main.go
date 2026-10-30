// looper-tsnet embeds Tailscale (tsnet) and reverse-proxies the tailnet to Looper's local server.
// stdout is one JSON object per line (see TsnetMessage in src/shared/remote-access.ts).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/tsnet"
)

const (
	proxySecretHeader = "x-looper-proxy-secret"
	proxyLoginHeader  = "x-looper-login"
	httpsCertsMessage = "Turn on HTTPS certificates for your tailnet in the Tailscale admin console (DNS page), then turn Remote Access off and on again."
)

var outMu sync.Mutex

func emit(v map[string]any) {
	outMu.Lock()
	defer outMu.Unlock()
	b, _ := json.Marshal(v)
	os.Stdout.Write(append(b, '\n'))
}

func status(state string, extra map[string]any) {
	m := map[string]any{"type": "status", "state": state}
	for k, v := range extra {
		m[k] = v
	}
	emit(m)
}

func logLine(level, msg string) {
	emit(map[string]any{"type": "log", "level": level, "message": msg})
}

func fail(msg string) {
	status("error", map[string]any{"message": msg})
	os.Exit(1)
}

func stderrLogf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

func newServer(dir, hostname string) *tsnet.Server {
	return &tsnet.Server{Dir: dir, Hostname: hostname, Logf: stderrLogf, UserLogf: stderrLogf}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "logout" {
		runLogout(os.Args[2:])
		return
	}
	runServe(os.Args[1:])
}

func runLogout(args []string) {
	fs := flag.NewFlagSet("logout", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	dir := fs.String("dir", "", "state folder")
	if err := fs.Parse(args); err != nil || *dir == "" {
		fail("Usage: looper-tsnet logout --dir <folder>")
	}
	s := newServer(*dir, "looper")
	if err := s.Start(); err != nil {
		fail("Could not start Tailscale: " + err.Error())
	}
	defer s.Close()
	lc, err := s.LocalClient()
	if err != nil {
		fail("Could not reach Tailscale: " + err.Error())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := lc.Logout(ctx); err != nil {
		fail("Could not sign out of Tailscale: " + err.Error())
	}
	status("logged-out", nil)
}

func runServe(args []string) {
	fs := flag.NewFlagSet("looper-tsnet", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	dir := fs.String("dir", "", "state folder")
	hostname := fs.String("hostname", "", "tailnet machine name")
	target := fs.String("target", "", "local server URL")
	if err := fs.Parse(args); err != nil {
		fail("Bad arguments: " + err.Error())
	}
	targetURL, err := url.Parse(*target)
	if *dir == "" || *hostname == "" || *target == "" || err != nil || targetURL.Host == "" {
		fail("Usage: looper-tsnet --dir <folder> --hostname <name> --target http://127.0.0.1:<port>")
	}
	secret := os.Getenv("LOOPER_PROXY_SECRET")

	status("starting", nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() { <-sig; cancel() }()
	go func() { io.Copy(io.Discard, os.Stdin); cancel() }()

	s := newServer(*dir, *hostname)
	if err := s.Start(); err != nil {
		fail("Could not start Tailscale: " + err.Error())
	}
	var servers []*http.Server
	shutdown := func() {
		sctx, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		for _, srv := range servers {
			srv.Shutdown(sctx)
			srv.Close()
		}
		s.Close()
	}

	lc, err := s.LocalClient()
	if err != nil {
		s.Close()
		fail("Could not reach Tailscale: " + err.Error())
	}

	lastLogin := ""
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			shutdown()
			return
		case <-tick.C:
		}
		st, err := lc.Status(ctx)
		if err != nil {
			continue
		}
		if st.BackendState == "NeedsLogin" && st.AuthURL != "" && st.AuthURL != lastLogin {
			lastLogin = st.AuthURL
			status("needs-login", map[string]any{"loginUrl": st.AuthURL})
			continue
		}
		if st.BackendState != "Running" || st.Self == nil {
			continue
		}
		if len(s.CertDomains()) == 0 {
			s.Close()
			fail(httpsCertsMessage)
		}
		login := ""
		if u, ok := st.User[st.Self.UserID]; ok {
			login = u.LoginName
		}
		dnsName := strings.TrimSuffix(st.Self.DNSName, ".")

		ln, err := s.ListenTLS("tcp", ":443")
		if err != nil {
			s.Close()
			fail("Could not listen on the tailnet: " + err.Error())
		}
		proxy := newProxy(targetURL)
		srv := &http.Server{Handler: guard(lc, proxy, secret)}
		servers = append(servers, srv)
		go func() {
			if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
				logLine("error", "HTTPS server stopped: "+err.Error())
				cancel()
			}
		}()
		if ln80, err := s.Listen("tcp", ":80"); err != nil {
			logLine("warn", "Could not listen on port 80: "+err.Error())
		} else {
			redir := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "https://"+r.Host+r.URL.RequestURI(), http.StatusMovedPermanently)
			})}
			servers = append(servers, redir)
			go redir.Serve(ln80)
		}
		running := map[string]any{"url": "https://" + dnsName, "dnsName": dnsName, "login": login}
		status("running", running)
		watch(ctx, lc, running)
		shutdown()
		return
	}
}

// watch reports a sign-in that lapses (an expired node key) and its return, until ctx ends.
func watch(ctx context.Context, lc *local.Client, running map[string]any) {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	lastLogin := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		st, err := lc.Status(ctx)
		if err != nil {
			continue
		}
		if st.BackendState == "NeedsLogin" && st.AuthURL != "" && st.AuthURL != lastLogin {
			lastLogin = st.AuthURL
			status("needs-login", map[string]any{"loginUrl": st.AuthURL})
		} else if st.BackendState == "Running" && lastLogin != "" {
			lastLogin = ""
			status("running", running)
		}
	}
}

// guard strips spoofable headers, identifies the caller and refuses tagged devices.
func guard(lc *local.Client, next http.Handler, secret string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for name := range r.Header {
			if strings.HasPrefix(strings.ToLower(name), "x-looper-") {
				r.Header.Del(name)
			}
		}
		who, err := lc.WhoIs(r.Context(), r.RemoteAddr)
		if err != nil || who == nil || who.UserProfile == nil || who.UserProfile.LoginName == "" ||
			(who.Node != nil && who.Node.IsTagged()) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		r.Header.Set(proxySecretHeader, secret)
		r.Header.Set(proxyLoginHeader, who.UserProfile.LoginName)
		next.ServeHTTP(w, r)
	})
}

func newProxy(target *url.URL) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		// Rewrite (not Director) so the client can't forge X-Forwarded-*; Go proxies WebSocket upgrades itself.
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Header.Set("X-Forwarded-Proto", "https")
			pr.Out.Header.Set("X-Forwarded-Host", pr.In.Host)
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			stderrLogf("proxy: %v", err)
			http.Error(w, "Looper is not reachable", http.StatusBadGateway)
		},
	}
}
