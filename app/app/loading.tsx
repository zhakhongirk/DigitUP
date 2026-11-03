export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="ws-title">
        <h1>&nbsp;</h1>
      </div>
      <section className="ib-empty glass" />
      <section className="ib-empty glass" />
    </div>
  );
}
