import { useSeoMeta } from "@unhead/react";
import { useLocation, Link } from "react-router-dom";
import { useEffect } from "react";

const NotFound = () => {
  const location = useLocation();

  useSeoMeta({
    title: "404 - Page Not Found — MIKI",
    description: "The page you are looking for could not be found. Return to the wallet to continue.",
  });

  useEffect(() => {
    console.error(
      "404 Error: User attempted to access non-existent route:",
      location.pathname
    );
  }, [location.pathname]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-black px-4">
      <div className="text-center">
        <h1 className="mb-4 text-6xl font-black text-yellow-400">404</h1>
        <p className="mb-8 text-2xl text-neutral-300">Oops! Page not found.</p>
        <Link
          to="/"
          className="inline-flex min-h-14 items-center rounded-2xl bg-yellow-400 px-8 text-xl font-bold text-black hover:bg-yellow-300 focus-visible:outline-4 focus-visible:outline-white"
        >
          Back to the wallet
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
