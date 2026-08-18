import { useEffect, useRef, type ReactNode } from 'react';
import { lockScroll, releaseScroll } from '../lib/scroll-lock.js';

/**
 * A right-hand modal sheet.
 *
 * Extracted because the product panel, the bag and the auth form all need the
 * same four behaviours, and each is easy to get subtly wrong in isolation:
 *
 *  - focus moves into the sheet on open and returns to the invoking control on
 *    close, so keyboard users are not dumped back at the top of the document;
 *  - Escape dismisses;
 *  - Tab is trapped, so focus cannot wander into the inert grid behind;
 *  - background scrolling is locked while open.
 */
interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Shown in the sheet's own bar, above the content. */
  title: string;
  labelledBy: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Sheet({ open, onClose, title, labelledBy, children, footer }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null;
      closeRef.current?.focus();
    } else if (restoreRef.current) {
      restoreRef.current.focus();
      restoreRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    lockScroll();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      releaseScroll();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="sheet" role="presentation">
      <div className="sheet__scrim" onClick={onClose} />

      <div
        className="sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={panelRef}
      >
        <div className="sheet__bar">
          <span className="label" data-tone="muted">
            {title}
          </span>
          <button
            type="button"
            className="sheet__close"
            onClick={onClose}
            aria-label="Close"
            ref={closeRef}
          >
            &times;
          </button>
        </div>

        <div className="sheet__scroll">{children}</div>

        {footer && <div className="sheet__footer">{footer}</div>}
      </div>
    </div>
  );
}
