import { useState } from 'react'
import { User, LogOut } from 'lucide-react'
import { motion } from 'framer-motion'
import type { MusicPlatform } from '../services/platforms'
import LoginPanel from './LoginPanel'
import QQLoginPanel from './QQLoginPanel'

interface LoginButtonProps {
  platform: MusicPlatform
  isLoggedIn: boolean
  username?: string
  onLogin: (cookie: string, username?: string, extra?: { avatar?: string; userId?: string }) => void
  onLogout: () => void
  playerTheme?: 'light' | 'dark'
}

export default function LoginButton({ platform, isLoggedIn, username, onLogin, onLogout, playerTheme = 'dark' }: LoginButtonProps) {
  const [showLoginPanel, setShowLoginPanel] = useState(false)
  
  const platformName = platform === 'netease' ? '网易云' : 'QQ音乐'
  const platformColor = platform === 'netease'
    ? 'bg-red-600 hover:bg-red-700'
    : 'bg-green-600 hover:bg-green-700'

  const handleLoginSuccess = (cookie: string, extraUsername?: string) => {
    onLogin(cookie, extraUsername)
    setShowLoginPanel(false)
  }

  return (
    <>
      {isLoggedIn ? (
        <motion.div
          whileHover={{ scale: 1.05 }}
          className={`flex items-center gap-3 px-4 py-2 rounded-full ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}
        >
          <div className="flex items-center gap-2">
            <User className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'}`} />
            <span className={`text-sm ${playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'}`}>{username || platformName}</span>
          </div>
          <button
            onClick={onLogout}
            className={`p-1 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
            title="登出"
          >
            <LogOut className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'}`} />
          </button>
        </motion.div>
      ) : (
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setShowLoginPanel(true)}
          className={`px-4 py-2 ${platformColor} text-white rounded-full text-sm font-medium transition-colors flex items-center gap-2`}
        >
          <User className="w-4 h-4" />
          登录{platformName}
        </motion.button>
      )}

      {showLoginPanel && platform === 'netease' && (
        <LoginPanel
          platform={platform}
          onClose={() => setShowLoginPanel(false)}
          onLoginSuccess={handleLoginSuccess}
        />
      )}

      {showLoginPanel && platform === 'qq' && (
        <QQLoginPanel
          onClose={() => setShowLoginPanel(false)}
          onLoginSuccess={handleLoginSuccess}
        />
      )}
    </>
  )
}

