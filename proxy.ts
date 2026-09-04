import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

function getSupabaseEnvironment() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL_PUBLIC ?? process.env.SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY_PUBLIC ?? process.env.SUPABASE_ANON_KEY,
  };
}

export async function proxy(request: NextRequest) {
  const { url, key } = getSupabaseEnvironment();
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);

  // Fail closed: a dashboard is never public if the auth service is unavailable.
  if (!url || !key) return NextResponse.redirect(loginUrl);

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.redirect(loginUrl);
  } catch {
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: "/dashboard/:path*",
};
