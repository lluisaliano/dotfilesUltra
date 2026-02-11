return {
  "https://github.com/ceigh/vercel-theme.nvim",
  lazy = false,
  priority = 1000,
  config = function()
    vim.cmd("colorscheme vercel")
  end,
}
