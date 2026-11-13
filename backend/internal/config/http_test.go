package config

import "testing"

func TestHTTPAddressAndReadinessShareTheConfiguredListener(t *testing.T) {
	for _, tc := range []struct{ address, want string }{
		{"", "http://127.0.0.1:8080/api/v1/health/ready"},
		{"127.0.0.1:9091", "http://127.0.0.1:9091/api/v1/health/ready"},
		{"0.0.0.0:9091", "http://127.0.0.1:9091/api/v1/health/ready"},
		{":9091", "http://127.0.0.1:9091/api/v1/health/ready"},
		{"[::]:9091", "http://[::1]:9091/api/v1/health/ready"},
		{"[::1]:9091", "http://[::1]:9091/api/v1/health/ready"},
		{"192.0.2.10:9091", "http://192.0.2.10:9091/api/v1/health/ready"},
		{"localhost:9091", "http://localhost:9091/api/v1/health/ready"},
	} {
		t.Run(tc.address, func(t *testing.T) {
			address := HTTPAddress(func(key string) string {
				if key != "HTTP_ADDR" {
					t.Fatal("unexpected configuration key", key)
				}
				return tc.address
			})
			got, err := ReadinessURL(address)
			if err != nil || got != tc.want {
				t.Fatal(got, err)
			}
		})
	}
	for _, address := range []string{"localhost", "127.0.0.1:", "http://127.0.0.1:8080", "::1:8080"} {
		if _, err := ReadinessURL(address); err == nil {
			t.Fatal("accepted malformed listener address")
		}
	}
}
