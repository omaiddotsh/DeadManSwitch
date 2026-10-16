import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg">
      <EmptyState
        icon="alert"
        title="Page not found"
        body="That route doesn't exist. Switch links look like /switch/<chainId>/<owner>/<id>."
        cta={<Link className="btn btn-primary" href="/">Go home</Link>}
      />
    </div>
  );
}
