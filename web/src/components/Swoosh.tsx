/**
 * The Swoosh, as served by nike.com (path lifted from the live header SVG).
 *
 * Nike trademark, reproduced here for an interview exercise only.
 */
export function Swoosh({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size * (18 / 24)}
      viewBox="0 0 24 18"
      role="img"
      aria-label="Nike"
      className={className}
      fill="none"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M21 2.719L7.836 8.303C6.74 8.768 5.818 9 5.075 9c-.836 0-1.445-.295-1.819-.884-.485-.76-.273-1.982.559-3.272.494-.754 1.122-1.446 1.734-2.108-.144.234-1.415 2.349-.025 3.345.275.2.666.298 1.147.298.386 0 .829-.063 1.316-.19L21 2.719z"
      />
    </svg>
  );
}
