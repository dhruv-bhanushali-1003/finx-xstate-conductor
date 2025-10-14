import axios from "axios";

const BASE_URL = "http://52.66.238.28:8127/api";

export async function GET(req) {
  const url = new URL(req.url);
  const targetUrl = `${BASE_URL}${url.searchParams.get("path") || ""}?${url.searchParams.toString()}`;
  try {
    const res = await axios.get(targetUrl);
    return new Response(JSON.stringify(res.data), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export async function POST(req) {
  const body = await req.json();
  const url = new URL(req.url);
  const targetUrl = `${BASE_URL}${body.path || ""}`;
  try {
    const res = await axios.post(targetUrl, body.data || {});
    return new Response(JSON.stringify(res.data), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
