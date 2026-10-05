export function FileDropHint({ dragging, children }: { dragging: boolean; children: React.ReactNode }) {
  return <div role="status" style={{ padding: '12px 14px', border: `1px dashed ${dragging ? '#8bddb7' : '#56627a'}`, borderRadius: 8, background: dragging ? '#254238' : '#232b3a', color: dragging ? '#c2ffe3' : '#adb5c8', fontSize: 13 }}>
    {children}
  </div>
}
