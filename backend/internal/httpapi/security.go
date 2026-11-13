package httpapi

import (
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/netip"
)

func (c Config) Validate() error {
	if err := validateAccountLifecycleConfig(c.AccountLifecycle); err != nil {
		return err
	}
	if len(c.AuthRateKey) != 32 {
		return errors.New("TROPA_AUTH_RATE_KEY must be an independent 256-bit server key")
	}
	if c.AccountLifecycle != nil && (subtle.ConstantTimeCompare(c.AccountLifecycle.MailKey,c.AuthRateKey)==1 || subtle.ConstantTimeCompare(c.AccountLifecycle.MailKey,c.ProxyToken)==1) {
		return errors.New("account mail encryption, authentication rate and proxy keys must be independent")
	}
	if len(c.TrustedProxyCIDRs) == 0 && len(c.ProxyToken) != 0 {
		return errors.New("TROPA_PROXY_TOKEN requires explicit TRUSTED_PROXY_CIDRS")
	}
	if len(c.TrustedProxyCIDRs) > 0 && len(c.ProxyToken) != 32 {
		return errors.New("TRUSTED_PROXY_CIDRS requires a 256-bit TROPA_PROXY_TOKEN")
	}
	for _, prefix := range c.TrustedProxyCIDRs {
		if !prefix.IsValid() || prefix.Bits() == 0 {
			return errors.New("invalid or internet-wide proxy trust range")
		}
	}
	if len(c.ProxyToken) == 32 && subtle.ConstantTimeCompare(c.AuthRateKey, c.ProxyToken) == 1 {
		return errors.New("authentication rate and proxy keys must be independent")
	}
	return nil
}

// Forwarding needs BOTH a configured direct peer and proof supplied by the
// trusted ingress/BFF. Neither X-Forwarded-For nor an arbitrary X-Real-IP is proof.
func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return "unknown"
	}
	peer = peer.Unmap()
	if len(s.cfg.ProxyToken) != 32 || len(r.Header.Values("X-Tropa-Proxy-Token")) != 1 || len(r.Header.Values("X-Real-IP")) != 1 {
		return peer.String()
	}
	proof := r.Header.Get("X-Tropa-Proxy-Token")
	if len(proof) != 64 {
		return peer.String()
	}
	provided, err := hex.DecodeString(proof)
	if err != nil || subtle.ConstantTimeCompare(provided, s.cfg.ProxyToken) != 1 {
		return peer.String()
	}
	for _, prefix := range s.cfg.TrustedProxyCIDRs {
		if prefix.Contains(peer) {
			if client, err := netip.ParseAddr(r.Header.Get("X-Real-IP")); err == nil && client.Zone() == "" {
				return client.Unmap().String()
			}
			break
		}
	}
	return peer.String()
}
