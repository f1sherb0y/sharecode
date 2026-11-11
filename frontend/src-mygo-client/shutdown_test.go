package main

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type shutdownFixture struct {
	locked     atomic.Int32
	background atomic.Int32
	entered    chan struct{}
	release    chan struct{}
	result     error
}

func (p *shutdownFixture) invoke(string, map[string]any) (any, error)  { return nil, nil }
func (p *shutdownFixture) lock() error                                 { p.locked.Add(1); return nil }
func (p *shutdownFixture) close()                                      {}
func (p *shutdownFixture) meeting(string, map[string]any) (any, error) { return nil, nil }
func (p *shutdownFixture) stopFeatures() error                         { return nil }
func (p *shutdownFixture) backgroundClose() error {
	p.background.Add(1)
	close(p.entered)
	<-p.release
	return p.result
}
func TestShutdownDoesNotBlockMainThreadAndRestoresBeforeExit(t *testing.T) {
	for _, failure := range []error{nil, errors.New("bounded restore timeout")} {
		fixture := &shutdownFixture{entered: make(chan struct{}), release: make(chan struct{}), result: failure}
		d := &Desktop{platform: fixture}
		done := make(chan struct{}, 2)
		returned := make(chan struct{})
		go func() { d.beginShutdownWith(func() { done <- struct{}{} }); close(returned) }()
		select {
		case <-returned:
		case <-time.After(time.Second):
			t.Fatal("shutdown blocked caller/UI thread")
		}
		<-fixture.entered
		if !d.locked.Load() || fixture.locked.Load() != 1 {
			t.Fatal("native features not locked before restoration")
		}
		if d.shutdownReady.Load() {
			t.Fatal("exit allowed before restoration completed")
		}
		d.beginShutdownWith(func() { done <- struct{}{} })
		if fixture.background.Load() != 1 {
			t.Fatal("duplicate shutdown restoration")
		}
		close(fixture.release)
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("no exit completion")
		}
		if !d.shutdownReady.Load() {
			t.Fatal("restoration did not release exit")
		}
		select {
		case <-done:
			t.Fatal("duplicate exit callback")
		default:
		}
	}
}
