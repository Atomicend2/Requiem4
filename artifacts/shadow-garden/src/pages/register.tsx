import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useVerifyOtp } from "@workspace/api-client-react/src/generated/api";
import { customFetch } from "@workspace/api-client-react/src/custom-fetch";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";

async function registerUser(data: { phone: string; name: string }) {
  return customFetch<{ success: boolean; message: string }>("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export default function Register() {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"details" | "verify">("details");
  const { login } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const registerMutation = useMutation({
    mutationFn: registerUser,
    onSuccess: (data: any) => {
      setStep("verify");
      if (data?.botOffline) {
        toast({
          title: "Account Created",
          description: "The bot is currently offline — use the Resend button once it's back online.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Account Created",
          description: "Check your WhatsApp for the verification code.",
        });
      }
    },
    onError: (error: any) => {
      const data = error?.data as any;
      if (data?.loginRedirect) {
        toast({
          title: "Already Registered",
          description: "This number already has an account. Redirecting to login...",
        });
        setTimeout(() => setLocation("/login"), 1500);
        return;
      }
      toast({
        title: "Registration Failed",
        description: error.message || "Something went wrong. Please try again.",
        variant: "destructive",
      });
    },
  });

  const verifyOtpMutation = useVerifyOtp({
    mutation: {
      onSuccess: (data) => {
        if (data.success && data.token) {
          login(data.token, data.user);
          toast({
            title: "Welcome to Requiem Order 反逆",
            description: "Your account is ready. The rebellion awaits.",
          });
          setLocation("/profile");
        }
      },
      onError: (error) => {
        toast({
          title: "Invalid Code",
          description: error.message || "The code is incorrect or expired.",
          variant: "destructive",
        });
      },
    },
  });

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone || !name) return;
    registerMutation.mutate({ phone, name });
  };

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code) return;
    verifyOtpMutation.mutate({ data: { phone, code } });
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden bg-background">
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/10 via-background to-background" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_0%,rgba(160,0,26,0.08),transparent)]" />
        <div className="absolute inset-0 bg-black/50" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        <div className="text-center mb-8">
          <p className="text-primary/40 font-mono tracking-[0.5em] text-sm uppercase mb-2">反逆</p>
          <h1 className="font-serif text-4xl font-bold bg-gradient-to-br from-rose-300 via-primary to-amber-300 bg-clip-text text-transparent neon-text-sky tracking-widest uppercase mb-2">
            REQUIEM ORDER
          </h1>
          <p className="text-muted-foreground tracking-[0.3em] uppercase text-xs">New Member Registration</p>
        </div>

        <Card className="glass-card border-primary/20 bg-black/40">
          <CardHeader>
            <CardTitle className="font-serif text-2xl text-center text-white">
              {step === "details" ? "Create Your Account" : "Verify Identity"}
            </CardTitle>
            <CardDescription className="text-center">
              {step === "details"
                ? "Enter your WhatsApp number and choose a display name."
                : "Enter the 6-digit code sent to your WhatsApp."}
            </CardDescription>
          </CardHeader>

          <CardContent>
            {step === "details" ? (
              <form onSubmit={handleRegister} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-primary tracking-[0.2em] uppercase text-xs">Display Name</Label>
                  <Input
                    id="name"
                    placeholder="e.g. Natsuki"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="bg-black/50 border-primary/30 text-white placeholder:text-muted-foreground focus-visible:ring-primary focus-visible:border-primary"
                    required
                    maxLength={32}
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone" className="text-primary tracking-[0.2em] uppercase text-xs">WhatsApp Number</Label>
                  <Input
                    id="phone"
                    placeholder="e.g. 2347012345678"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                    className="bg-black/50 border-primary/30 text-white placeholder:text-muted-foreground focus-visible:ring-primary focus-visible:border-primary font-mono tracking-wider"
                    required
                    inputMode="numeric"
                    maxLength={15}
                  />
                  <p className="text-xs text-muted-foreground">
                    Numbers only — include country code without +.{" "}
                    <span className="text-primary/60 font-mono">234... · 233... · 27... · 91...</span>
                  </p>
                </div>
                <Button
                  type="submit"
                  className="w-full bg-primary hover:bg-primary/80 text-white font-bold tracking-[0.2em] uppercase h-12 neon-border-sky"
                  disabled={!phone || !name || registerMutation.isPending}
                >
                  {registerMutation.isPending ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    "Create Account"
                  )}
                </Button>
              </form>
            ) : (
              <form onSubmit={handleVerify} className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="code" className="text-primary tracking-[0.2em] uppercase text-xs">Verification Code</Label>
                  <Input
                    id="code"
                    placeholder="6-digit code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="bg-black/50 border-primary/30 text-white text-center tracking-[0.5em] text-lg focus-visible:ring-primary focus-visible:border-primary"
                    maxLength={6}
                    required
                    autoFocus
                    inputMode="numeric"
                  />
                  <p className="text-xs text-muted-foreground text-center">
                    Sent to <span className="text-primary font-mono">+{phone}</span> via WhatsApp
                  </p>
                </div>
                <div className="flex gap-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 border-primary/30 text-white hover:bg-primary/20"
                    onClick={() => setStep("details")}
                    disabled={verifyOtpMutation.isPending}
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    className="flex-[2] bg-primary hover:bg-primary/80 text-white font-bold tracking-[0.2em] uppercase h-12 neon-border-sky"
                    disabled={!code || verifyOtpMutation.isPending}
                  >
                    {verifyOtpMutation.isPending ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      "Verify & Enter"
                    )}
                  </Button>
                </div>
                <p className="text-xs text-center text-muted-foreground">
                  Didn't receive it?{" "}
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => registerMutation.mutate({ phone, name })}
                    disabled={registerMutation.isPending}
                  >
                    Resend code
                  </button>
                </p>
              </form>
            )}
          </CardContent>

          <CardFooter className="justify-center border-t border-primary/10 pt-6">
            <p className="text-xs text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="text-primary hover:underline">
                Sign in
              </Link>
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
