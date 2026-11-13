// Package config shares process configuration that must agree across binaries.
package config

import (
	"errors"
	"net"
	"net/url"
)

const DefaultHTTPAddress = "127.0.0.1:8080"

func HTTPAddress(getenv func(string) string) string {
	if address := getenv("HTTP_ADDR"); address != "" {
		return address
	}
	return DefaultHTTPAddress
}

// ReadinessURL probes the same listener as the API. A wildcard bind address is
// replaced with loopback in its address family; a specific bind is preserved.
func ReadinessURL(address string) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port == "" {
		return "", errors.New("HTTP_ADDR must contain a host and port")
	}
	if host == "" {
		host = "127.0.0.1"
	} else if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
		if ip.To4() != nil {
			host = "127.0.0.1"
		} else {
			host = "::1"
		}
	}
	probe := url.URL{Scheme: "http", Host: net.JoinHostPort(host, port), Path: "/api/v1/health/ready"}
	return probe.String(), nil
}
