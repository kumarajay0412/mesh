/** The Mesh mark (user-provided) — a woven X in signal yellow.
 *  `spin` renders the pulsing "agent is working" variant. */
export function MeshMark({ size = 18, color = 'var(--ada-gold-400)', spin = false }: { size?: number; color?: string; spin?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 26 26"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={spin ? { animation: 'meshPulse 1.4s ease-in-out infinite' } : undefined}
    >
      <path
        d="M6.5 3.25H19.5M6.5 22.75H19.5M7.58333 3.25C7.58333 8.66667 12.4583 10.2917 13 13M13 13C13.5417 10.2917 18.4167 8.66667 18.4167 3.25M13 13C12.4583 15.7083 7.58333 17.3333 7.58333 22.75M13 13C13.5417 15.7083 18.4167 17.3333 18.4167 22.75"
        stroke={color}
        strokeWidth="1.89583"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
