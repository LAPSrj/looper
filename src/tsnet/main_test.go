package main

import (
	"net/http"
	"testing"
)

func TestStripProxyHeadersKeepsTheRequestHeader(t *testing.T) {
	h := http.Header{}
	h.Set("X-Looper-Proxy-Secret", "forged")
	h.Set("x-looper-login", "someone@example.com")
	h.Set("X-Looper-Request", "1")
	stripProxyHeaders(h)
	if h.Get(proxySecretHeader) != "" || h.Get(proxyLoginHeader) != "" {
		t.Fatalf("forged proxy headers survived: %v", h)
	}
	if h.Get("X-Looper-Request") != "1" {
		t.Fatalf("X-Looper-Request was removed: %v", h)
	}
}
