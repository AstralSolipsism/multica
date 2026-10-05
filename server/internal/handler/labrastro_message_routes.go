package handler

import "github.com/go-chi/chi/v5"

// RegisterLabrastroMessageRoutes mounts all delivery endpoints inside the
// caller's authenticated router. Scope-specific authorization stays in handlers.
func (h *Handler) RegisterLabrastroMessageRoutes(r chi.Router) {
	r.Get("/api/autopilots/{id}/message-routes", h.ListMessageRoutes)
	r.Post("/api/autopilots/{id}/message-routes", h.CreateMessageRoute)
	r.Route("/api/autopilots/{id}/message-routes/{routeId}", func(r chi.Router) {
		r.Put("/", h.UpdateMessageRoute)
		r.Delete("/", h.DeleteMessageRoute)
		r.Post("/enable", h.SetMessageRouteEnabled)
		r.Post("/test-send", h.TestMessageRoute)
	})
	// Approved external targets: workspace-admin consent per
	// (automation, bot, target). Approval is categorically
	// above automation write permission; the handler
	// re-checks owner/admin inside.
	r.Get("/api/autopilots/{id}/message-approved-targets", h.ListMessageApprovedTargets)
	r.Post("/api/autopilots/{id}/message-approved-targets", h.ApproveMessageTarget)
	r.Delete("/api/autopilots/{id}/message-approved-targets/{targetId}", h.RevokeMessageTarget)
	r.Get("/api/autopilots/{id}/message-deliveries", h.ListMessageDeliveries)
	r.Route("/api/autopilots/{id}/message-deliveries/{deliveryId}", func(r chi.Router) {
		r.Get("/", h.GetMessageDelivery)
		r.Post("/retry", h.RetryMessageDelivery)
	})

	// Labrastro personal/team notification sources (OL-27).
	// Same module, separate scope surface; see
	// internal/handler/labrastro_message_sources.go.
	r.Get("/api/message-event-catalog", h.GetMessageEventCatalog)
	r.Route("/api/message-routes", func(r chi.Router) {
		r.Get("/", h.ListMessageSourceRoutes)
		r.Post("/", h.CreateMessageSourceRoute)
		r.Route("/{routeId}", func(r chi.Router) {
			r.Put("/", h.UpdateMessageSourceRoute)
			r.Delete("/", h.DeleteMessageSourceRoute)
			r.Post("/enable", h.SetMessageSourceRouteEnabled)
			r.Post("/test-send", h.TestMessageSourceRoute)
			r.Get("/message-deliveries", h.ListMessageRouteDeliveries)
			r.Route("/message-deliveries/{deliveryId}", func(r chi.Router) {
				r.Get("/", h.GetMessageRouteDelivery)
				r.Post("/retry", h.RetryMessageRouteDelivery)
			})
		})
	})
	r.Get("/api/message-approved-targets", h.ListMessageSourceApprovedTargets)
	r.Post("/api/message-approved-targets", h.ApproveMessageSourceTarget)
	r.Delete("/api/message-approved-targets/{targetId}", h.RevokeMessageSourceTarget)
}
