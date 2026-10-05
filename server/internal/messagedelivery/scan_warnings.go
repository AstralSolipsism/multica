package messagedelivery

import "time"

const sourceHorizonWarningInterval = 10 * time.Minute

// A long transaction or an unobservable writer can keep the stable horizon
// behind indefinitely. Warn once per scanner per interval without advancing it.
// Database time avoids comparing host and database clocks.
func (s *Service) warnSourceHorizon(scanner string, through, stable time.Time) {
	lag := through.Sub(stable)
	if lag < sourceHorizonWarningInterval {
		return
	}
	s.scanWarningMu.Lock()
	defer s.scanWarningMu.Unlock()
	if last, ok := s.scanWarnings[scanner]; ok && through.Before(last.Add(sourceHorizonWarningInterval)) {
		return
	}
	if s.scanWarnings == nil {
		s.scanWarnings = make(map[string]time.Time)
	}
	s.scanWarnings[scanner] = through
	s.logger().Warn("messagedelivery: source scan horizon is lagging",
		"scanner", scanner, "stable_at", stable, "lag", lag)
}
