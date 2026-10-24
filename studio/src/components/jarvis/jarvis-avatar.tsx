'use client';

// jarvis-avatar.tsx — the animated character face.
//
// Pure SVG + CSS (no canvas, no library, no images): it renders in a 60fps
// HUD panel on an i3 laptop, themes itself from the active persona's hue, and
// reacts to the same states the reactor uses (idle / listening / thinking /
// speaking). The visor, the eye shape and the "hair" arc change with gender so
// a female character does not look like a recoloured butler.

import { useId } from 'react';

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type AvatarGender = 'male' | 'female' | 'neutral';

interface JarvisAvatarProps {
  gender?: AvatarGender;
  /** 0-360, the persona accent */
  hue?: number;
  state?: AvatarState;
  size?: number;
  /** optional initials shown on the chest plate */
  label?: string;
}

const STATE_COLOR: Record<AvatarState, string> = {
  idle: 'var(--jv-accent, #1fd4ff)',
  listening: '#34d399',
  thinking: '#a78bfa',
  speaking: '#f59e0b',
};

export function JarvisAvatar({
  gender = 'male',
  hue = 190,
  state = 'idle',
  size = 120,
  label,
}: JarvisAvatarProps) {
  const uid = useId().replace(/[:]/g, '');
  const accent = STATE_COLOR[state];
  const glow = state === 'idle' ? 0.35 : 0.85;

  return (
    <div
      className="jv-avatar relative shrink-0"
      style={{ width: size, height: size }}
      data-state={state}
      data-gender={gender}
      aria-label={`Character (${gender}), ${state}`}
      role="img"
    >
      <style>{`
        .jv-avatar svg { display:block; width:100%; height:100%; overflow:visible; }
        .jv-avatar .jv-ring { transform-origin: 50% 50%; animation: jv-spin 14s linear infinite; }
        .jv-avatar[data-state="thinking"] .jv-ring { animation-duration: 2.4s; }
        .jv-avatar .jv-eye { animation: jv-blink 5.2s infinite; transform-origin: center; }
        .jv-avatar[data-state="listening"] .jv-eye { animation: jv-pulse-eye 1.6s ease-in-out infinite; }
        .jv-avatar[data-state="thinking"] .jv-eye { animation: jv-pulse-eye 0.9s ease-in-out infinite; }
        .jv-avatar[data-state="speaking"] .jv-mouth { animation: jv-talk 0.42s ease-in-out infinite; }
        .jv-avatar[data-state="listening"] .jv-wave { animation: jv-wave 1.1s ease-in-out infinite; }
        .jv-avatar[data-state="speaking"] .jv-wave { animation: jv-wave 0.6s ease-in-out infinite; }
        .jv-avatar[data-state="thinking"] .jv-wave { animation: jv-wave 1.8s ease-in-out infinite; }
        @keyframes jv-spin { to { transform: rotate(360deg); } }
        @keyframes jv-blink { 0%,96%,100% { transform: scaleY(1); } 98% { transform: scaleY(0.12); } }
        @keyframes jv-pulse-eye { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }
        @keyframes jv-talk { 0%,100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }
        @keyframes jv-wave { 0%,100% { transform: scaleY(0.4); opacity: 0.6; } 50% { transform: scaleY(1); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .jv-avatar * { animation: none !important; }
        }
      `}</style>

      <svg viewBox="0 0 120 120" aria-hidden="true">
        <defs>
          <radialGradient id={`glow-${uid}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={accent} stopOpacity={glow * 0.55} />
            <stop offset="70%" stopColor={accent} stopOpacity="0.06" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`plate-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`hsl(${hue} 60% 22%)`} />
            <stop offset="100%" stopColor={`hsl(${hue} 70% 9%)`} />
          </linearGradient>
        </defs>

        {/* halo */}
        <circle cx="60" cy="60" r="58" fill={`url(#glow-${uid})`} />
        <g className="jv-ring" opacity="0.55">
          <circle
            cx="60"
            cy="60"
            r="52"
            fill="none"
            stroke={accent}
            strokeWidth="1"
            strokeDasharray="6 10"
            opacity="0.5"
          />
        </g>

        {/* shoulders / chest plate */}
        <path
          d="M18 112 Q60 84 102 112 L102 118 L18 118 Z"
          fill={`url(#plate-${uid})`}
          stroke={accent}
          strokeOpacity="0.35"
        />
        {label ? (
          <text
            x="60"
            y="110"
            textAnchor="middle"
            fontSize="8"
            letterSpacing="2"
            fill={accent}
            fillOpacity="0.8"
            fontFamily="monospace"
          >
            {label.slice(0, 10).toUpperCase()}
          </text>
        ) : null}

        {/* head */}
        {gender === 'female' ? (
          <>
            {/* side-swept hair */}
            <path
              d="M32 52 Q30 22 60 20 Q90 22 88 52 Q84 34 60 32 Q36 34 32 52 Z"
              fill={`hsl(${hue} 55% 16%)`}
              stroke={accent}
              strokeOpacity="0.4"
            />
            <path d="M30 54 Q26 78 34 92" stroke={`hsl(${hue} 55% 16%)`} strokeWidth="7" fill="none" strokeLinecap="round" />
            <path d="M90 54 Q94 78 86 92" stroke={`hsl(${hue} 55% 16%)`} strokeWidth="7" fill="none" strokeLinecap="round" />
            <ellipse cx="60" cy="58" rx="24" ry="27" fill={`url(#plate-${uid})`} stroke={accent} strokeOpacity="0.55" />
            <ellipse cx="60" cy="60" rx="17" ry="13" fill="#04121b" stroke={accent} strokeOpacity="0.55" />
            <ellipse className="jv-eye" cx="53" cy="60" rx="3.4" ry="2.4" fill={accent} />
            <ellipse className="jv-eye" cx="67" cy="60" rx="3.4" ry="2.4" fill={accent} />
            <rect className="jv-mouth" x="55" y="69" width="10" height="2.4" rx="1.2" fill={accent} opacity="0.85" />
          </>
        ) : gender === 'neutral' ? (
          <>
            <circle cx="60" cy="58" r="30" fill={`url(#plate-${uid})`} stroke={accent} strokeOpacity="0.5" />
            <circle cx="60" cy="58" r="21" fill="none" stroke={accent} strokeOpacity="0.35" strokeDasharray="3 4" />
            <circle className="jv-eye" cx="60" cy="58" r="6" fill={accent} fillOpacity="0.85" />
            <circle className="jv-eye" cx="60" cy="58" r="11" fill="none" stroke={accent} strokeOpacity="0.4" />
          </>
        ) : (
          <>
            {/* angular helmet + jaw */}
            <path
              d="M34 44 L44 28 L76 28 L86 44 L82 76 L60 92 L38 76 Z"
              fill={`url(#plate-${uid})`}
              stroke={accent}
              strokeOpacity="0.55"
            />
            <path d="M30 50 L38 40 L38 74 L32 66 Z" fill={`hsl(${hue} 60% 18%)`} stroke={accent} strokeOpacity="0.3" />
            <path d="M90 50 L82 40 L82 74 L88 66 Z" fill={`hsl(${hue} 60% 18%)`} stroke={accent} strokeOpacity="0.3" />
            <rect x="40" y="52" width="40" height="15" rx="5" fill="#04121b" stroke={accent} strokeOpacity="0.6" />
            <rect className="jv-eye" x="46" y="57" width="9" height="4" rx="2" fill={accent} />
            <rect className="jv-eye" x="65" y="57" width="9" height="4" rx="2" fill={accent} />
            <rect className="jv-mouth" x="52" y="74" width="16" height="2.6" rx="1.3" fill={accent} opacity="0.85" />
          </>
        )}

        {/* voice bars — only visible while listening/speaking/thinking */}
        <g transform="translate(96 60)">
          {[0, 1, 2].map((i) => (
            <rect
              key={i}
              className="jv-wave"
              x={i * 6}
              y={-6}
              width="3"
              height="12"
              rx="1.5"
              fill={accent}
              opacity={state === 'idle' ? 0.15 : 0.85}
              style={{ animationDelay: `${i * 0.12}s`, transformOrigin: 'center' }}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

export default JarvisAvatar;
