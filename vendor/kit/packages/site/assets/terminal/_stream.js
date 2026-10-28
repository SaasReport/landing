  const stream = async (V, pre, html) => { const L = html.split("\n"); pre.innerHTML = ""; for (let i = 1; i <= L.length; i++) { pre.innerHTML = L.slice(0, i).join("\n"); await V.wait(110); } };
