package server

import "net/http"

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("GET /api/tours", h(a.listSeenTours))
		mux.HandleFunc("PUT /api/tours/{id}", h(a.markTourSeen))
	})
}

// tours are the guided tours the client knows. An account sees each one
// once: finishing or skipping it marks it seen for every device.
var tours = []string{"schedule"}

func (a *App) listSeenTours(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	seen, err := scalar[[]string](r.Context(), a.DB, `SELECT "seenTours" FROM "User" WHERE id = $1`, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to load tours")
	}
	if seen == nil {
		seen = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"seen": seen})
	return nil
}

func (a *App) markTourSeen(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	tour := r.PathValue("id")
	known := false
	for _, name := range tours {
		known = known || name == tour
	}
	if !known {
		return notFound("Tour not found")
	}
	seen, err := scalar[[]string](r.Context(), a.DB, `UPDATE "User" SET "seenTours" = CASE WHEN $2 = ANY("seenTours") THEN "seenTours"
            ELSE array_append("seenTours", $2) END
        WHERE id = $1 RETURNING "seenTours"`, authUser.ID, tour)
	if err != nil {
		return dbError(err, "Failed to save tour")
	}
	if seen == nil {
		seen = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"seen": seen})
	return nil
}
