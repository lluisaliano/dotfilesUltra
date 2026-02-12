local function apply_vercel_overrides()
  if vim.g.colors_name ~= "vercel" then
    return
  end

  local set_hl = vim.api.nvim_set_hl

  -- Make clangd/LSP inline hints readable on the Vercel dark background.
  set_hl(0, "LspInlayHint", { fg = "#7D838A", bg = "NONE", italic = true })

  -- Improve statusline contrast and mode pill readability.
  set_hl(0, "StatusLine", { fg = "#AEB6C2", bg = "#020202" })
  set_hl(0, "StatusLineNC", { fg = "#5F6670", bg = "#020202" })
  set_hl(0, "lualine_a_normal", { fg = "#000000", bg = "#43AAF9", bold = true })
  set_hl(0, "lualine_a_insert", { fg = "#000000", bg = "#62C073", bold = true })
  set_hl(0, "lualine_a_visual", { fg = "#000000", bg = "#BF7AF0", bold = true })
  set_hl(0, "lualine_a_replace", { fg = "#000000", bg = "#E34234", bold = true })
  set_hl(0, "lualine_a_command", { fg = "#000000", bg = "#FCE094", bold = true })
end

local theme_state_file = vim.fn.stdpath("state") .. "/theme-picker-colorscheme"

local function persist_theme(name)
  if not name or name == "" then
    return
  end

  local dir = vim.fn.fnamemodify(theme_state_file, ":h")
  pcall(vim.fn.mkdir, dir, "p")
  pcall(vim.fn.writefile, { name }, theme_state_file)
end

local function read_persisted_theme()
  local ok, lines = pcall(vim.fn.readfile, theme_state_file)
  if not ok or not lines or not lines[1] or lines[1] == "" then
    return nil
  end
  return lines[1]
end

return {
  {
    "https://github.com/ceigh/vercel-theme.nvim",
    lazy = false,
    priority = 1000,
    config = function()
      local group = vim.api.nvim_create_augroup("lluis_vercel_overrides", { clear = true })

      vim.api.nvim_create_autocmd("ColorScheme", {
        group = group,
        callback = function()
          vim.schedule(apply_vercel_overrides)
        end,
      })

      vim.api.nvim_create_autocmd("User", {
        group = group,
        pattern = "LazyVimStarted",
        callback = apply_vercel_overrides,
      })

      local theme = read_persisted_theme() or "vercel"
      local ok = pcall(vim.cmd.colorscheme, theme)
      if not ok then
        vim.cmd.colorscheme("vercel")
        persist_theme("vercel")
      end
      apply_vercel_overrides()
    end,
  },

  {
    "folke/snacks.nvim",
    optional = true,
    keys = {
      {
        "<leader>uT",
        function()
          Snacks.picker.colorschemes({
            confirm = function(picker, item)
              picker:close()
              if item then
                picker.preview.state.colorscheme = nil
                vim.schedule(function()
                  vim.cmd.colorscheme(item.text)
                  persist_theme(item.text)
                end)
              end
            end,
          })
        end,
        desc = "Theme Picker",
      },
    },
  },
}
