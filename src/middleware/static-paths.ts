// The API Library's own web pages and files (HTML shell, scripts, stylesheet, fonts, logo). They are filled in when the pages are
// registered (routes/libraryUi.ts) and are NOT counted by the per-address rate limiter: one page view fetches twenty or so of them,
// so counting them would lock a person (or an office sharing one address) out of the website after a handful of clicks.
// The limiter is for API calls; these files are public, small and served from memory.
export const LIBRARY_UI_STATIC_PATHS = new Set<string>();
