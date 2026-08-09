import { useEffect, useRef, useState } from "react";

function splitLines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

export function LineListTextarea({
  resetVersion,
  value,
  onChange,
}: {
  resetVersion: number;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const joinedValue = value.join("\n");
  const [rawValue, setRawValue] = useState(joinedValue);
  const focusedRef = useRef(false);
  const joinedValueRef = useRef(joinedValue);
  joinedValueRef.current = joinedValue;

  useEffect(() => {
    if (!focusedRef.current) setRawValue(joinedValue);
  }, [joinedValue]);

  useEffect(() => setRawValue(joinedValueRef.current), [resetVersion]);

  return (
    <textarea
      rows={4}
      value={rawValue}
      onFocus={() => { focusedRef.current = true; }}
      onChange={(event) => {
        setRawValue(event.target.value);
        onChange(splitLines(event.target.value));
      }}
      onBlur={() => {
        focusedRef.current = false;
        setRawValue(joinedValue);
      }}
    />
  );
}
