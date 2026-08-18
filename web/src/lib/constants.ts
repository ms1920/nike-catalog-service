/**
 * Mirrors `MAX_QUANTITY_PER_LINE` in `src/domain/cart.ts`.
 *
 * Duplicated because the browser bundle must not import server code. The server
 * remains the authority — it rejects an over-cap request regardless of what the
 * client believes — so the worst case if these drift is a stepper that stays
 * enabled for one click too long and then shows a server error. In a production
 * repo this constant would come from a generated OpenAPI client instead.
 */
export const MAX_QUANTITY = 10;
