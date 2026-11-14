/** 产品标识：一个中枢节点连着三个端点，对应「联智中枢」。 */
export function BrandGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 8 3.5 4M8 8l4.5-4M8 8v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="8" r="2.3" fill="currentColor" />
      <circle cx="3.5" cy="4" r="1.5" fill="currentColor" />
      <circle cx="12.5" cy="4" r="1.5" fill="currentColor" />
      <circle cx="8" cy="13" r="1.5" fill="currentColor" />
    </svg>
  );
}
