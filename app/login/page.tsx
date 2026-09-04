"use client";

import Image from "next/image";
import { ArrowRight, BadgeCheck, Eye, EyeOff, LockKeyhole, Mail } from "lucide-react";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const formData = new FormData(event.currentTarget);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: String(formData.get("email") ?? ""),
        password: String(formData.get("password") ?? ""),
      });

      if (signInError) {
        setError("E-mail ou senha inválidos. Tente novamente.");
        return;
      }

      const next = new URLSearchParams(window.location.search).get("next");
      const destination = next?.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
      router.replace(destination);
      router.refresh();
    } catch {
      setError("Não foi possível iniciar sua sessão. Verifique a configuração do Supabase.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return <main className="relative flex min-h-screen overflow-hidden bg-[#f4faf6] text-[#172033]"><section className="relative z-10 mx-auto flex w-full max-w-[1320px] items-center px-5 py-6 sm:px-8 lg:px-12"><div className="grid w-full overflow-hidden rounded-[30px] border border-[#e2f0e6] bg-white shadow-[0_24px_80px_rgba(46,88,62,0.1)] lg:grid-cols-[1.08fr_0.92fr]"><div className="relative hidden min-h-[680px] items-center justify-center overflow-hidden bg-[#dff2e5] p-12 lg:flex"><div className="absolute -left-20 -top-20 size-80 rounded-full border-[38px] border-white/30" /><div className="absolute -bottom-28 -right-24 size-96 rounded-full bg-[#c9e9d3]" /><div className="relative flex flex-col items-center"><Image src="/logo baueflow.webp" alt="BaueFlow" width={480} height={220} className="h-auto w-[380px] max-w-full drop-shadow-[0_16px_26px_rgba(34,91,55,0.12)]" priority /><div className="mt-10 flex items-center gap-2 rounded-full border border-[#b8dec4] bg-white/60 px-5 py-2.5 text-sm font-semibold text-[#24633e]"><span>BaueFlow Automação</span><BadgeCheck className="size-[19px] fill-[#3b9b5e] text-white" aria-label="Verificado" /></div></div></div><div className="flex min-h-[680px] flex-col px-6 py-8 sm:px-12 sm:py-10 lg:px-[72px]"><Image src="/logo baueflow.webp" alt="BaueFlow" width={160} height={48} className="h-auto w-32 lg:hidden" priority /><div className="my-auto w-full max-w-[390px] lg:max-w-none"><p className="mb-3 text-sm font-semibold text-[#2d7a4d]">BEM-VINDO DE VOLTA</p><h1 className="text-3xl font-semibold tracking-[-0.035em]">Acesse sua conta</h1><p className="mt-3 text-[15px] leading-6 text-[#687086]">Entre com seus dados para continuar para o BaueFlow.</p><form className="mt-9 space-y-5" onSubmit={handleSubmit}><label className="block"><span className="mb-2 block text-sm font-medium text-[#30394d]">E-mail</span><span className="flex h-12 items-center rounded-xl border border-[#dfe2ea] bg-white px-4 transition focus-within:border-[#2d7a4d] focus-within:ring-4 focus-within:ring-[#2d7a4d]/10"><Mail className="mr-3 size-[18px] text-[#9198a9]" /><input name="email" className="w-full bg-transparent text-sm outline-none placeholder:text-[#a3a9b8]" type="email" placeholder="seuemail@empresa.com" autoComplete="email" required disabled={isSubmitting} /></span></label><label className="block"><span className="mb-2 block text-sm font-medium text-[#30394d]">Senha</span><span className="flex h-12 items-center rounded-xl border border-[#dfe2ea] bg-white px-4 transition focus-within:border-[#2d7a4d] focus-within:ring-4 focus-within:ring-[#2d7a4d]/10"><LockKeyhole className="mr-3 size-[18px] text-[#9198a9]" /><input name="password" className="w-full bg-transparent text-sm outline-none placeholder:text-[#a3a9b8]" type={showPassword ? "text" : "password"} placeholder="Digite sua senha" autoComplete="current-password" required disabled={isSubmitting} /><button type="button" onClick={() => setShowPassword(!showPassword)} className="ml-3 text-[#9198a9] transition hover:text-[#2d7a4d]" aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}>{showPassword ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}</button></span></label><div className="flex items-center justify-between gap-4 text-sm"><label className="flex cursor-pointer items-center gap-2 text-[#687086]"><input type="checkbox" className="size-4 rounded border-[#c9ceda] accent-[#2d7a4d]" />Lembrar de mim</label><button type="button" className="font-medium text-[#2d7a4d] hover:text-[#205f3a]">Esqueci minha senha</button></div>{error && <p role="alert" className="rounded-xl bg-[#fff0ef] px-3 py-2.5 text-sm text-[#b5423a]">{error}</p>}<button type="submit" disabled={isSubmitting} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#2d7a4d] text-sm font-semibold text-white shadow-[0_10px_18px_rgba(45,122,77,0.24)] transition hover:-translate-y-0.5 hover:bg-[#205f3a] disabled:cursor-not-allowed disabled:opacity-70">{isSubmitting ? "Entrando..." : "Entrar na plataforma"}<ArrowRight className="size-[18px]" /></button></form></div><p className="pt-8 text-center text-sm text-[#7c8395]">Ainda não tem uma conta? <button type="button" className="font-semibold text-[#2d7a4d] hover:text-[#205f3a]">Fale com a gente</button></p></div></div></section></main>;
}
