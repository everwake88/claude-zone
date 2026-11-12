// Shown the instant a page is chosen, in the shape the page will take, while its data arrives.
export default function Loading() {
  return (
    <div className="page" aria-busy="true">
      <div className="head"><div><div className="sk" style={{ width: 260, height: 30 }} /><div className="sk" style={{ width: 380, height: 16, marginTop: 10 }} /></div></div>
      <div className="ov">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card sk-card"><div className="sk" style={{ width: '55%', height: 12 }} /><div className="sk" style={{ width: '40%', height: 26 }} /></div>
        ))}
        <div className="card w2" style={{ minHeight: 300, padding: 22 }}><div className="sk" style={{ width: '30%', height: 16 }} /><div className="sk" style={{ height: 220, marginTop: 20 }} /></div>
        <div className="card" style={{ minHeight: 300 }} />
        <div className="card" style={{ minHeight: 300 }} />
      </div>
    </div>
  );
}
