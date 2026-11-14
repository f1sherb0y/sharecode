//go:build !windows && !darwin

package main

import (
	"errors"

	"github.com/egoist/mygo"
)

// Windows and macOS have a native side; elsewhere the client is a plain window.
type unsupportedPlatform struct{}

const showWhenReady = true

func platformWindowOptions(*mygo.WindowOptions) {}

var errUnsupported = errors.New("This platform's native features are not available in the MyGo client")

func attachPlatform(*Desktop, *mygo.Window) (platformClient, error) {
	return unsupportedPlatform{}, nil
}

func (unsupportedPlatform) invoke(string, map[string]any) (any, error)  { return nil, errUnsupported }
func (unsupportedPlatform) meeting(string, map[string]any) (any, error) { return nil, errUnsupported }
func (unsupportedPlatform) lock() error                                 { return nil }
func (unsupportedPlatform) stopFeatures() error                         { return nil }
func (unsupportedPlatform) backgroundClose() error                      { return nil }
func (unsupportedPlatform) close()                                      {}
