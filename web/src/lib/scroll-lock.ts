/**
 * Reference-counted background scroll lock.
 *
 * The naive version — each modal saving `body.style.overflow` on open and
 * restoring it on close — breaks as soon as two modals overlap, which happens
 * here every time "Sign In to Add" swaps the product panel for the auth sheet.
 * The second sheet mounts while the first is still open, captures the *locked*
 * value `'hidden'` as the thing to restore, and puts it back on close. The page
 * is then permanently unscrollable with no modal on screen, which is exactly the
 * "page won't scroll and content is cut off" symptom.
 *
 * A counter fixes it: only the first lock records the original value and only the
 * last release restores it.
 */

let depth = 0;
let originalOverflow: string | null = null;

export function lockScroll(): void {
  if (depth === 0) {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  depth += 1;
}

export function releaseScroll(): void {
  // Guard against an unbalanced release driving the count negative, which would
  // make the next genuine lock fail to apply.
  if (depth === 0) return;

  depth -= 1;
  if (depth === 0) {
    document.body.style.overflow = originalOverflow ?? '';
    originalOverflow = null;
  }
}
