import { Suspense } from "react";
import { JoinForm } from "@/components/phone/JoinForm";

export const metadata = { title: "Gambit Rodeo · Sit down" };

export default function JoinPage() {
  return (
    <Suspense>
      <JoinForm />
    </Suspense>
  );
}
