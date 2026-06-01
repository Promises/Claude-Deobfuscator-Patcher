import App from "@/components/App";
import { StudioProvider } from "@/lib/StudioContext";

export default function Page() {
  return (
    <StudioProvider>
      <App />
    </StudioProvider>
  );
}
