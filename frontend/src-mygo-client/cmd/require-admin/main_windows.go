//go:build windows

// Command require-admin makes a built client start as administrator: it adds
// requestedExecutionLevel requireAdministrator to the application manifest
// that mygo build embedded, which has no setting for it. Windows then asks
// for consent (UAC) at every start.
//
// The client needs it for its keyboard hook: a low-level hook of a process
// that is not elevated sees no keys while an elevated window has the focus.
//
//	go run ./cmd/require-admin -file build/.../sharecode-client.exe
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"log"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	rtManifest      = 24
	manifestID      = 1
	asDataFile      = 0x2  // LOAD_LIBRARY_AS_DATAFILE
	asImageResource = 0x20 // LOAD_LIBRARY_AS_IMAGE_RESOURCE
)

const trustInfo = `  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
`

var (
	kernel32              = windows.NewLazySystemDLL("kernel32.dll")
	enumResourceLanguages = kernel32.NewProc("EnumResourceLanguagesW")
	findResourceEx        = kernel32.NewProc("FindResourceExW")
	beginUpdateResource   = kernel32.NewProc("BeginUpdateResourceW")
	updateResource        = kernel32.NewProc("UpdateResourceW")
	endUpdateResource     = kernel32.NewProc("EndUpdateResourceW")
)

func main() {
	file := flag.String("file", "", "the executable to change")
	flag.Parse()
	if *file == "" {
		log.Fatal("-file is required")
	}
	if err := requireAdministrator(*file); err != nil {
		log.Fatal(err)
	}
}

// withTrustInfo returns manifest asking for administrator rights.
func withTrustInfo(manifest []byte) ([]byte, error) {
	if bytes.Contains(manifest, []byte("requestedExecutionLevel")) {
		return nil, errors.New("the manifest already names an execution level")
	}
	end := bytes.LastIndex(manifest, []byte("</assembly>"))
	if end < 0 {
		return nil, errors.New("the manifest has no </assembly>")
	}
	out := append([]byte{}, manifest[:end]...)
	out = append(out, trustInfo...)
	return append(out, manifest[end:]...), nil
}

func requireAdministrator(path string) error {
	language, manifest, err := readManifest(path)
	if err != nil {
		return err
	}
	manifest, err = withTrustInfo(manifest)
	if err != nil {
		return err
	}
	if err = writeManifest(path, language, manifest); err != nil {
		return err
	}
	_, written, err := readManifest(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(written, manifest) {
		return errors.New("the manifest read back differs from the one written")
	}
	return nil
}

// readManifest returns the application manifest of an executable and the
// language it is stored under.
func readManifest(path string) (language uint16, manifest []byte, err error) {
	module, err := windows.LoadLibraryEx(path, 0, asDataFile|asImageResource)
	if err != nil {
		return 0, nil, fmt.Errorf("%s: %w", path, err)
	}
	defer windows.FreeLibrary(module)
	var languages []uint16
	callback := windows.NewCallback(func(_, _, _ uintptr, language uint16, _ uintptr) uintptr {
		languages = append(languages, language)
		return 1
	})
	enumResourceLanguages.Call(uintptr(module), rtManifest, manifestID, callback, 0)
	if len(languages) != 1 {
		return 0, nil, fmt.Errorf("%s: %d application manifests, expected one", path, len(languages))
	}
	language = languages[0]
	info, _, e := findResourceEx.Call(uintptr(module), rtManifest, manifestID, uintptr(language))
	if info == 0 {
		return 0, nil, fmt.Errorf("FindResourceEx: %w", e)
	}
	manifest, err = windows.LoadResourceData(module, windows.Handle(info))
	if err != nil {
		return 0, nil, err
	}
	return language, append([]byte{}, manifest...), nil
}

func writeManifest(path string, language uint16, manifest []byte) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	update, _, e := beginUpdateResource.Call(uintptr(unsafe.Pointer(name)), 0)
	if update == 0 {
		return fmt.Errorf("BeginUpdateResource: %w", e)
	}
	ok, _, e := updateResource.Call(update, rtManifest, manifestID, uintptr(language), uintptr(unsafe.Pointer(&manifest[0])), uintptr(len(manifest)))
	if ok == 0 {
		endUpdateResource.Call(update, 1)
		return fmt.Errorf("UpdateResource: %w", e)
	}
	if ok, _, e = endUpdateResource.Call(update, 0); ok == 0 {
		return fmt.Errorf("EndUpdateResource: %w", e)
	}
	return nil
}
