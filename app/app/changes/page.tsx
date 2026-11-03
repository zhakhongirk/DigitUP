import { redirect } from "next/navigation";

export default async function ChangesRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, item);
    }
  }
  const qs = query.toString();
  redirect(qs ? `/app/approvals?${qs}` : "/app/approvals");
}
