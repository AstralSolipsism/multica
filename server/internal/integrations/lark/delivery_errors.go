package lark

import (
	"errors"
	"net/http"
)

// One taxonomy for delivery, target verification and target discovery. Callers
// translate these provider facts into their own public errors; they do not keep
// independent lists of business codes.
type larkFailure int

const (
	larkUnknown larkFailure = iota
	larkRejected
	larkInvalidRequest
	larkChatUnavailable
	larkMessageUnavailable
	larkPermissionDenied
	larkRateLimited
	larkUnavailable
)

func classifyLarkFailure(err error) larkFailure {
	code, _, hasCode := larkErrorCodeMsg(err)
	switch code {
	case 230001, 232001:
		return larkInvalidRequest
	case 230002, 230013, 230014, 230073, 232006, 232009, 232010, 232011:
		return larkChatUnavailable
	case 230011, 230019, 230110:
		return larkMessageUnavailable
	case 230027, 232033, 99991672, 99991676, 99991679:
		return larkPermissionDenied
	case 230020, 99991400, 99991403:
		return larkRateLimited
	case 230006, 232004, 232025, 232034:
		// Keep these business refusals permanent for sends and verification;
		// discovery still presents them as unavailable. They are not 5xx retries.
		return larkRejected
	case 230049, codeTenantTokenInvalid, codeAppTokenInvalid:
		// In-flight response or credentials rejected after the client's refresh:
		// keep the existing conservative send treatment.
		return larkUnknown
	}
	var status *larkAPIStatusError
	if errors.As(err, &status) {
		switch {
		case status.StatusCode == http.StatusTooManyRequests:
			return larkRateLimited
		case status.StatusCode == http.StatusForbidden:
			return larkPermissionDenied
		case status.StatusCode >= 500 && hasCode:
			return larkUnavailable
		}
	}
	if hasCode {
		return larkRejected
	}
	// A gateway failure without a provider verdict does not prove rejection.
	return larkUnknown
}
