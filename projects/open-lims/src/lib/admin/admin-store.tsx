import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  MOCK_BRANCHES,
  MOCK_CATALOG,
  MOCK_PARAMS,
  MOCK_ROLES,
  MOCK_USERS,
  type AdminRole,
  type AdminUser,
  type Branch,
  type CatalogItem,
  type SystemParam,
} from "./mock-data";

interface AdminStore {
  users: AdminUser[];
  roles: AdminRole[];
  branches: Branch[];
  catalog: CatalogItem[];
  params: SystemParam[];
  toggleUserStatus: (id: string) => void;
  toggleBranch: (id: string) => void;
  toggleCatalogItem: (id: string) => void;
  updateParam: (id: string, value: string) => void;
}

const AdminStoreContext = createContext<AdminStore | null>(null);

export function AdminStoreProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<AdminUser[]>(MOCK_USERS);
  const [roles] = useState<AdminRole[]>(MOCK_ROLES);
  const [branches, setBranches] = useState<Branch[]>(MOCK_BRANCHES);
  const [catalog, setCatalog] = useState<CatalogItem[]>(MOCK_CATALOG);
  const [params, setParams] = useState<SystemParam[]>(MOCK_PARAMS);

  const value = useMemo<AdminStore>(
    () => ({
      users,
      roles,
      branches,
      catalog,
      params,
      toggleUserStatus: (id) =>
        setUsers((prev) =>
          prev.map((u) =>
            u.id === id ? { ...u, status: u.status === "off" ? "active" : "off" } : u,
          ),
        ),
      toggleBranch: (id) =>
        setBranches((prev) => prev.map((b) => (b.id === id ? { ...b, active: !b.active } : b))),
      toggleCatalogItem: (id) =>
        setCatalog((prev) => prev.map((c) => (c.id === id ? { ...c, active: !c.active } : c))),
      updateParam: (id, newValue) =>
        setParams((prev) => prev.map((p) => (p.id === id ? { ...p, value: newValue } : p))),
    }),
    [users, roles, branches, catalog, params],
  );

  return <AdminStoreContext.Provider value={value}>{children}</AdminStoreContext.Provider>;
}

export function useAdminData(): AdminStore {
  const ctx = useContext(AdminStoreContext);
  if (!ctx) throw new Error("useAdminData phải nằm trong AdminStoreProvider");
  return ctx;
}
