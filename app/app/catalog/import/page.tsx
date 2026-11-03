import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { ownerOnly } from "@/server/owner/access";
import { currentOwner } from "@/server/owner/session";
import { ImportForm } from "./import-form";
import "./import.css";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("ri.title");

export default async function ImportPage() {
  const services = await getServices();
  const [{ t }, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/app/catalog/import");
  ownerOnly(owner);

  return (
    <>
      <div className="ws-title">
        <div>
          <h1>{t("ri.title")}</h1>
          <p className="ws-sub">{t("ri.sub")}</p>
        </div>
        <Link href="/app/catalog" className="btn btn-sm btn-secondary">
          {t("ri.back")}
        </Link>
      </div>

      <section className="ri-card glass" aria-label={t("ri.card")}>
        <ImportForm />
        <ul className="ri-notes">
          <li>{t("ri.note1")}</li>
          <li>{t("ri.note2")}</li>
          <li>{t("ri.note3")}</li>
        </ul>
      </section>
    </>
  );
}
