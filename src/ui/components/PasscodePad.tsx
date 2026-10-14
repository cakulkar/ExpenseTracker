import { useEffect, useRef, useState } from 'react';
import { PASSCODE_LENGTH } from '../../lock/passcode';

/** 6-digit entry: works with the on-screen keypad, a hardware keyboard, and screen readers. */
export function PasscodePad(props: { label: string; onComplete: (code: string) => void; disabled?: boolean; resetKey?: number }) {
  const [code, setCode] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCode('');
    inputRef.current?.focus();
  }, [props.resetKey]);

  const update = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, PASSCODE_LENGTH);
    setCode(clean);
    if (clean.length === PASSCODE_LENGTH) props.onComplete(clean);
  };

  return (
    <div className="pad">
      <label htmlFor="passcode" className="pad-label">{props.label}</label>
      <input
        ref={inputRef}
        id="passcode"
        className="pad-input"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        pattern="\d*"
        maxLength={PASSCODE_LENGTH}
        value={code}
        disabled={props.disabled}
        onChange={(e) => update(e.target.value)}
        aria-describedby="passcode-dots"
      />
      <div className="dots" id="passcode-dots" aria-label={`${code.length} of ${PASSCODE_LENGTH} digits entered`}>
        {Array.from({ length: PASSCODE_LENGTH }, (_, i) => (
          <span key={i} className={`pdot ${i < code.length ? 'on' : ''}`} />
        ))}
      </div>
      <div className="keys" aria-hidden="true">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) =>
          k === '' ? (
            <span key={i} />
          ) : (
            <button
              key={i}
              type="button"
              tabIndex={-1}
              className="key"
              disabled={props.disabled}
              onClick={() => update(k === '⌫' ? code.slice(0, -1) : code + k)}
            >
              {k}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
