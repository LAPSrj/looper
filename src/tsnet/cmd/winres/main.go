// Command winres writes the Windows resource object (icon and version info)
// that go build links into looper-tsnet.exe. scripts/build-tsnet.mjs runs it
// before go build; it is not part of the helper binary.
//
// Usage: go run ./cmd/winres <version> <icon.ico> <out.syso> <arch>
package main

import (
	"fmt"
	"os"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

func run(ver, icoPath, outPath, arch string) error {
	ico, err := os.Open(icoPath)
	if err != nil {
		return err
	}
	defer ico.Close()
	icon, err := winres.LoadICO(ico)
	if err != nil {
		return fmt.Errorf("reading %s: %w", icoPath, err)
	}

	rs := &winres.ResourceSet{}
	if err := rs.SetIcon(winres.ID(1), icon); err != nil {
		return err
	}

	var vi version.Info
	vi.SetFileVersion(ver)
	vi.SetProductVersion(ver)
	for k, v := range map[string]string{
		version.FileDescription:  "Looper Tailscale Helper",
		version.ProductName:      "Looper",
		version.InternalName:     "looper-tsnet",
		version.OriginalFilename: "looper-tsnet.exe",
		version.FileVersion:      ver,
		version.ProductVersion:   ver,
	} {
		if err := vi.Set(version.LangDefault, k, v); err != nil {
			return err
		}
	}
	rs.SetVersionInfo(vi)

	out, err := os.Create(outPath)
	if err != nil {
		return err
	}
	if err := rs.WriteObject(out, winres.Arch(arch)); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func main() {
	if len(os.Args) != 5 {
		fmt.Fprintln(os.Stderr, "usage: winres <version> <icon.ico> <out.syso> <arch>")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Args[3], os.Args[4]); err != nil {
		fmt.Fprintln(os.Stderr, "winres:", err)
		os.Exit(1)
	}
}
