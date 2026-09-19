import { PhoneController } from "@/components/phone/PhoneController";

export const metadata = { title: "Gambit Rodeo · Controller" };

export default async function PlayPage({ params }: { params: Promise<{ room: string }> }) {
  const { room } = await params;
  return <PhoneController room={room.toUpperCase()} />;
}
