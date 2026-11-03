export const membershipRoles = ["owner", "admin", "developer", "operator", "viewer"] as const;
export type MembershipRole = (typeof membershipRoles)[number];
export const membershipRoleLabels: Record<MembershipRole, string> = {
  owner: "Proprietário",
  admin: "Administrador",
  developer: "Desenvolvedor",
  operator: "Operador",
  viewer: "Leitura",
};

/** Product roles only. Validation grants never participate in this policy. */
export function organizationCapabilities(role: MembershipRole) {
  return {
    manageOrganization: role === "owner" || role === "admin",
    manageMembers: role === "owner" || role === "admin",
    manageIntegrations: role === "owner" || role === "admin" || role === "developer",
    operateDocuments: role === "owner" || role === "admin" || role === "operator",
    // The console reads fiscal data by company; a developer reads it through its integrations.
    readDocuments: role !== "developer",
  };
}

/** Admins cannot grant or modify ownership/administration, including their own. */
export function canManageRole(actor: MembershipRole, target: MembershipRole) {
  return actor === "owner" || (actor === "admin" && target !== "owner" && target !== "admin");
}
