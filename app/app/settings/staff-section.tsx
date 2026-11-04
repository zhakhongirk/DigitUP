import { isMailConfigured } from "@/server/mail";
import { getServices } from "@/server/container";
import type { TenantContext } from "@/server/services/context";
import { StaffPanel } from "./staff-panel";

export async function StaffSection({ owner }: { owner: TenantContext }) {
  const services = await getServices();
  const staff = await services.tenancy.listStaff(owner);
  return (
    <StaffPanel
      staff={staff.map(({ id, email }) => ({ id, email }))}
      mailConfigured={isMailConfigured()}
    />
  );
}
