/** @jsxImportSource solid-js */

export const ScreenshotWrapper = (props: { children: any; title?: string }) => (
  <div style={{
    width: '1920px',
    height: '1080px',
    background: 'linear-gradient(135deg, #1e1e2e 0%, #11111b 100%)',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    padding: '60px',
    'box-sizing': 'border-box'
  }}>
    <div style={{
      width: '100%',
      height: '100%',
      background: 'rgba(30, 30, 46, 0.7)',
      'backdrop-filter': 'blur(16px)',
      'border-radius': '24px',
      border: '1px solid rgba(255, 255, 255, 0.1)',
      'box-shadow': '0 30px 60px -12px rgba(0, 0, 0, 0.6)',
      overflow: 'hidden',
      display: 'flex',
      'flex-direction': 'column'
    }}>
      <div style={{
        padding: '16px 24px',
        'border-bottom': '1px solid rgba(255, 255, 255, 0.05)',
        background: 'rgba(255, 255, 255, 0.03)',
        display: 'flex',
        'align-items': 'center',
        gap: '12px'
      }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <div style={{ width: '12px', height: '12px', 'border-radius': '50%', background: '#ff5f56', border: '1px solid rgba(0,0,0,0.1)' }} />
          <div style={{ width: '12px', height: '12px', 'border-radius': '50%', background: '#ffbd2e', border: '1px solid rgba(0,0,0,0.1)' }} />
          <div style={{ width: '12px', height: '12px', 'border-radius': '50%', background: '#27c93f', border: '1px solid rgba(0,0,0,0.1)' }} />
        </div>
        <div style={{ 
          flex: 1, 
          'text-align': 'center', 
          color: 'rgba(255, 255, 255, 0.4)', 
          'font-family': 'Inter, system-ui, sans-serif', 
          'font-size': '13px',
          'font-weight': '500',
          'letter-spacing': '0.05em',
          'text-transform': 'uppercase'
        }}>
          {props.title || 'CodeNomad UI Component Preview'}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {props.children}
      </div>
    </div>
  </div>
)
