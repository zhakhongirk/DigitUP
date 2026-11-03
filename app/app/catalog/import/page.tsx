import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { currentOwner } from "@/server/owner/session";
import { ImportForm } from "./import-form";
import "./import.css";

export const metadata: Metadata = { title: "Update from file" };

export default async function ImportPage() {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/catalog/import");

  return (
    <>
      <div className="ws-title">
        <div>
          <h1>Update from file</h1>
          <p className="ws-sub">
            Upload a new price list and review what changes before it goes live.
          </p>
        </div>
        <Link href="/app/catalog" className="btn btn-sm btn-secondary">
          Back to catalog
        </Link>
      </div>

      <section className="ri-card glass" aria-label="Upload price list">
        <ImportForm />
        <ul className="ri-notes">
          <li>XLSX, CSV, PDF or DOCX, up to 20 MB.</li>
          <li>Rows are matched to your offers by SKU or code, then by name.</li>
          <li>Nothing is removed. Offers missing from the file are only listed.</li>
        </ul>
      </section>
    </>
  );
}
