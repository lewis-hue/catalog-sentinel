export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading page">
      <div className="page-header">
        <div>
          <span className="skel" style={{ width: 90, height: 11 }} />
          <span className="skel" style={{ width: 240, height: 28, marginTop: 10 }} />
          <span className="skel" style={{ width: 360, maxWidth: '75vw', height: 14, marginTop: 10 }} />
        </div>
      </div>
      <section className="card" aria-hidden>
        <span className="skel" style={{ width: '65%', height: 18 }} />
        <span className="skel" style={{ width: '90%', height: 13, marginTop: 14 }} />
        <span className="skel" style={{ width: '80%', height: 13, marginTop: 8 }} />
      </section>
    </div>
  );
}
