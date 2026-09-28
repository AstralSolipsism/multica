import { notFound } from "next/navigation";

// OL-14: this self-hosted instance does not serve public marketing pages.
export default function RetiredMarketingPage() {
  notFound();
}
