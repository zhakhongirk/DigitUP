import { ownerT } from "@/server/owner/lang";

export default async function Loading() {
  const { t } = await ownerT();
  return (
    <div aria-busy="true" aria-label={t("common.loading")}>
      <div className="ws-title">
        <h1>&nbsp;</h1>
      </div>
      <section className="ib-empty glass" />
      <section className="ib-empty glass" />
    </div>
  );
}
