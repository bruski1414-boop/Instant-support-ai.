function configureRenderProxyTrust(app, env = process.env) {
  if (env.NODE_ENV === "production" && env.RENDER_EXTERNAL_URL) {
    app.set("trust proxy", 1);
    return true;
  }
  return false;
}

module.exports = { configureRenderProxyTrust };
