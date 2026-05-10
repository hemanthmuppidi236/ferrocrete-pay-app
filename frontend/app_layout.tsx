import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Topbar } from "@/components/topbar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Derive display name + initials from auth metadata
  const fullName =
    (user.user_metadata?.full_name as string | undefined) ||
    (user.user_metadata?.name as string | undefined) ||
    (user.email ? user.email.split("@")[0] : "User");
  const firstName = fullName.split(" ")[0] || "User";
  const initials = fullName
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || "U";

  return (
    <>
      <Topbar
        email={user.email || ""}
        firstName={firstName}
        initials={initials}
      />
      {children}
    </>
  );
}
