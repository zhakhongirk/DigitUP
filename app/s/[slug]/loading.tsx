export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading catalog">
      <section className="sf-hero">
        <div className="sf-skel sf-skel-title" />
        <div className="sf-skel sf-skel-line" />
      </section>
      <div className="sf-skel sf-skel-search" />
      <ul className="sf-grid sf-skel-grid">
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i} className="sf-card">
            <div className="sf-skel sf-card-media" />
            <div className="sf-skel sf-skel-line" />
            <div className="sf-skel sf-skel-line sf-skel-short" />
          </li>
        ))}
      </ul>
    </div>
  );
}
