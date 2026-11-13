package main

import (
	"net/http"
	"os"
	"time"

	"tropa/backend/internal/config"
)

func main() {
	if !ready(config.HTTPAddress(os.Getenv)) {
		os.Exit(1)
	}
}

func ready(address string) bool {
	url, err := config.ReadinessURL(address)
	if err != nil {
		return false
	}
	// Probe this process directly even if HTTP_PROXY is set. A redirect is not
	// readiness and must not turn a response from another service into success.
	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	c := http.Client{Timeout: 2 * time.Second, Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	r, err := c.Get(url)
	if err != nil {
		return false
	}
	defer r.Body.Close()
	return r.StatusCode == http.StatusOK
}
