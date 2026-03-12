'use client';

import type { LoadStatus } from './useInstruments';

interface Props {
  status: LoadStatus;
}

export default function LoadingScreen({ status }: Props) {
  const isDownloading = status.phase === 'downloading';
  const progress = isDownloading ? status.progress : 0;

  const label: Record<string, string> = {
    checking: 'Checking cache...',
    'cache-hit': 'Loading from cache...',
    downloading: `Downloading instruments... ${progress}%`,
    decompressing: 'Decompressing data...',
    parsing: 'Parsing instruments...',
    storing: 'Saving to cache...',
    error: `Error: ${status.phase === 'error' ? status.message : ''}`,
  };

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: '#171717' }}>
      {/* Animated cloud download icon */}
      <div className="relative mb-8">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 512 512"
          className="w-24 h-24"
          fill="#fafafa"
          style={{ filter: 'drop-shadow(0 0 16px rgba(255,152,0,0.6))' }}
        >
          {/* Cloud + arrow path — same icon you shared */}
          <path d="M288 32c-80.8 0-145.5 36.8-192.6 80.6C56.6 156 28.3 205.2 28.3 256c0 89.4 71.4 162.8 160.2 167.9L192 424H96c-17.7 0-32 14.3-32 32s14.3 32 32 32h320c17.7 0 32-14.3 32-32s-14.3-32-32-32h-96l3.5-.1C412.6 418.8 484 345.4 484 256c0-50.8-28.3-100-67.1-143.4C369.5 68.8 304.8 32 224 32h64zm-32 96c8.8 0 16 7.2 16 16v150.1l39-39c6.2-6.2 16.4-6.2 22.6 0s6.2 16.4 0 22.6l-67 67c-6.2 6.2-16.4 6.2-22.6 0l-67-67c-6.2-6.2-6.2-16.4 0-22.6s16.4-6.2 22.6 0l39 39V144c0-8.8 7.2-16 16-16z"/>
        </svg>

        {/* Animated bouncing arrow overlay */}
        <div
          className="absolute bottom-1 left-1/2 -translate-x-1/2"
          style={{ animation: 'bounce-arrow 1.2s ease-in-out infinite' }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className="w-8 h-8"
            fill="none"
            stroke="#FF9800"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="2" x2="12" y2="18" />
            <polyline points="6 12 12 18 18 12" />
          </svg>
        </div>
      </div>

      {/* Progress bar — only shown while downloading */}
      {isDownloading && (
        <div className="w-64 overflow-hidden mb-4" style={{ height: 2, background: '#2a2a2a' }}>
          <div
            className="h-full transition-all duration-300"
            style={{ background: '#FF9800', width: `${progress}%` }}
          />
        </div>
      )}

      {/* Spinner for non-download phases */}
      {!isDownloading && status.phase !== 'error' && (
        <div className="w-6 h-6 border-2 mb-4"
          style={{ borderColor: '#2a2a2a', borderTopColor: '#FF9800', animation: 'spin 0.8s linear infinite', borderRadius: 0 }}
        />
      )}

      <p style={{ fontSize: 11, color: '#a1a1aa', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        {label[status.phase] ?? ''}
      </p>
    </div>
  );
}
