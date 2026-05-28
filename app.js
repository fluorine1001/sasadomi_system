// Render 또는 Vercel에 배포한 본인의 API 주소로 연동
const BACKEND_API_URL = 'https://sasadomi-system.vercel.app';

// 백엔드와 맞춘 API Key (Firebase Firestore의 developers 컬렉션 문서 ID와 매칭)
const SASADOMI_API_KEY = 'dev_abc123xyz'; 

let currentStudentId = '';
let currentSessionToken = ''; // 로그인 세션 토큰을 메모리에 안전하게 유지할 전역 변수

// 🟢 일시 문자열 가독성 및 일관성 포맷터 함수
function formatDateTime(str) {
    if (!str) return '';
    return str
        .replace(/\s*(\([일월화수목금토]\))\s*/g, ' $1 ')
        .trim()
        .replace(/\s+/g, ' ');
}

window.addEventListener('DOMContentLoaded', () => {
    // 🟢 화면 로드 시 서버에서 드롭다운 옵션들을 받아와 채워넣습니다.
    fetchOptions(); 

    const savedToken = localStorage.getItem('sasa_sessionToken');
    if (savedToken) {
        if (document.getElementById('rememberMe')) {
            document.getElementById('rememberMe').checked = true;
        }
        autoLogin(savedToken);
    }
});

// 📌 REST API v1: 메타데이터(드롭다운 옵션) 로드
async function fetchOptions() {
    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/meta/options`, {
            headers: { 'x-api-key': SASADOMI_API_KEY }
        });
        const data = await res.json();
        if (data.success) {
            populateSelect('studyTime', data.studyTimes);
            populateSelect('studyPlace', data.studyPlaces);
            populateSelect('studyDetail', data.teachers.map(t => ({value: t, label: t})));
            populateSelect('outBtime', data.outTimes.map(t => ({value: t, label: t})));
            populateSelect('outEtime', data.outTimes.map(t => ({value: t, label: t})));
            
            // 옵션 로드 완료 후 현재 선택된 장소에 맞게 UI를 한 번 초기화합니다.
            const initialPlace = document.getElementById('studyPlace');
            if(initialPlace) toggleStudyFields(initialPlace.value);
        }
    } catch (error) { console.error("옵션 데이터 로드 실패", error); }
}

function populateSelect(id, optionsList) {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = '';
    optionsList.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        select.appendChild(option);
    });
}

// 📌 REST API v1: 상벌점 데이터 별도 호출
async function fetchPoints(studentId, token) {
    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/points?studentId=${studentId}&token=${token}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY }
        });
        
        const data = await res.json();
        if (data.success) {
            renderDashboard(data); 
        } else { console.error("상벌점 내역 조회 실패:", data.message); }
    } catch (error) { console.error("상벌점 내역 통신 오류:", error); }
}

// 📌 REST API v1: 자동 로그인
async function autoLogin(token) {
    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/auth/auto-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({ token })
        });

        const data = await res.json();
        if (data.success) {
            currentStudentId = data.studentId;
            currentSessionToken = token;
            
            const loginForm = document.getElementById('loginForm');
            if (loginForm) loginForm.style.display = 'none';

            fetchPoints(currentStudentId, currentSessionToken);
            fetchApplications(currentStudentId, currentSessionToken);
        } else {
            clearSession();
        }
    } catch (error) { console.error('자동 로그인 실패:', error); }
}

// 📌 REST API v1: 최초 로그인 및 연동
async function syncAccount() {
    const rawStudentId = document.getElementById('studentId').value;
    const studentPw = document.getElementById('studentPw').value;

    if (!rawStudentId || !studentPw) return alert('아이디와 패스워드를 적어주세요.');

    const studentId = rawStudentId.trim().toLowerCase();
    if (studentId.length !== 11 || !studentId.startsWith('s')) {
        return alert('올바른 학번 양식(s년도학년반번호)으로 입력해 주세요.\n예: s2026030601');
    }

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({ studentId, studentPw }) 
        });

        const data = await res.json();
        if (data.success) {
            currentStudentId = studentId;
            currentSessionToken = data.sessionToken;

            if (document.getElementById('rememberMe') && document.getElementById('rememberMe').checked) {
                localStorage.setItem('sasa_sessionToken', data.sessionToken);
            } else {
                clearSession();
            }

            const loginForm = document.getElementById('loginForm');
            if (loginForm) loginForm.style.display = 'none';

            fetchPoints(currentStudentId, currentSessionToken);
            fetchApplications(currentStudentId, currentSessionToken);
            alert('성공적으로 계정이 연동 및 최신 데이터 동기화 완료되었습니다.');
        } else {
            alert(data.message || '인증 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// 📌 대시보드 UI 렌더링 (🟢 상벌점 내역 코멘트 표시 유지)
function renderDashboard(data) {
    if (document.getElementById('rewardView')) document.getElementById('rewardView').innerText = data.totalReward;
    if (document.getElementById('penaltyView')) document.getElementById('penaltyView').innerText = data.totalPenalty;

    const renderRows = (tableId, list) => {
        const tbody = document.querySelector(`${tableId} tbody`);
        if (!tbody) return;

        tbody.innerHTML = '';
        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#999;">내역이 없습니다.</td></tr>';
            return;
        }
        
        list.forEach(item => {
            // 사유 텍스트 조합
            let reasonHtml = `<span>${item.reason || ''}</span>`;
            
            // 코멘트가 있을 경우 폰트를 작게, 연한 색으로 사유 하단에 추가
            if (item.comment) {
                reasonHtml += `<div style="font-size: 0.85em; color: #888; margin-top: 4px;">↳ ${item.comment}</div>`;
            }

            // 🟢 표의 순서(번호, 점수, 내용, 날짜)에 맞게 4열 출력
            tbody.innerHTML += `<tr>
                <td>${item.no || '-'}</td>
                <td><strong>${item.score || 0}</strong></td>
                <td style="text-align: left;">${reasonHtml}</td>
                <td>${item.date}</td>
            </tr>`;
        });
    };

    renderRows('#rewardTable', data.rewardList || []);
    renderRows('#penaltyTable', data.penaltyList || []);

    if (document.getElementById('dashboard')) document.getElementById('dashboard').style.display = 'block';
}

function clearSession() { localStorage.removeItem('sasa_sessionToken'); }

// 🟢 장소가 '본관(3)'일 때만 지도교사 및 상세 사유 UI 그룹을 보여줍니다.
function toggleStudyFields(placeValue) {
    const detailGroup = document.getElementById('studyDetailGroup');
    if (detailGroup) {
        if (placeValue === '3') {
            detailGroup.style.display = 'block';
        } else {
            detailGroup.style.display = 'none';
        }
    }
}

// 📌 REST API v1: 자율학습 신청
async function submitStudy() {
    const rawDate = document.getElementById('studyDate').value;
    const time = document.getElementById('studyTime').value;
    const place = document.getElementById('studyPlace').value;
    
    if (!rawDate) return alert('날짜를 지정해 주세요.');
    
    // ⭐ 한국 시간(KST) 00:00:00 기준으로 정확한 초 단위 타임스탬프 계산 (수정 사항 적용)
    const targetDate = new Date(rawDate + 'T00:00:00+09:00');
    const timestampSeconds = Math.floor(targetDate.getTime() / 1000);

    const activeToken = currentSessionToken || localStorage.getItem('sasa_sessionToken');

    const payload = { 
        studentId: currentStudentId, 
        token: activeToken, 
        date: timestampSeconds, 
        time: time, 
        place: place 
    };

    // 본관일 때만 detail과 detail_reason을 담고, 아닐 경우 강제로 비웁니다.
    if (place === '3') {
        payload.detail = document.getElementById('studyDetail').value;
        payload.detail_reason = document.getElementById('studyDetailReason').value;
        if (!payload.detail_reason) return alert('본관 사유를 기록해 주세요.');
    } else {
        payload.detail = '';
        payload.detail_reason = '';
    }

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/applications/study`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.success) {
            alert('자율학습 신청 대행 요청이 처리되었습니다!');
            closeModal('studyModal');
            fetchApplications(currentStudentId, activeToken);
        } else { alert(data.message || '신청 실패'); }
    } catch (error) { alert('서버 통신 중 오류가 발생했습니다.'); }
}

// 📌 REST API v1: 외출/외박 신청
async function submitOut() {
    const outType = document.getElementById('outType').value;
    const outReason = document.getElementById('outReason').value;
    const bDateInput = document.getElementById('outBdate').value;
    const bTimeInput = document.getElementById('outBtime').value;
    const eDateInput = document.getElementById('outEdate').value;
    const eTimeInput = document.getElementById('outEtime').value;

    if (!bDateInput || !eDateInput || !outReason) return alert('필수 항목을 빠짐없이 기입해 주세요.');

    // ⭐ 한국 시간(KST) 타임존을 강제 지정하여 정확한 초 단위 타임스탬프 계산 (수정 사항 적용)
    const bDateTime = new Date(`${bDateInput}T${bTimeInput}:00+09:00`);
    const eDateTime = new Date(`${eDateInput}T${eTimeInput}:00+09:00`);

    const bdateSec = Math.floor(bDateTime.getTime() / 1000);
    const edateSec = Math.floor(eDateTime.getTime() / 1000);

    const activeToken = currentSessionToken || localStorage.getItem('sasa_sessionToken');

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/applications/out`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({ 
                studentId: currentStudentId, 
                token: activeToken, 
                type: outType, 
                reason: outReason, 
                bdate: bdateSec, 
                edate: edateSec 
            })
        });

        const data = await res.json();
        if (data.success) {
            alert('외출/외박 신청 연동 처리가 수락되었습니다.');
            closeModal('outModal');
            fetchApplications(currentStudentId, activeToken);
        } else { alert(data.message || '신청 실패'); }
    } catch (error) { alert('서버 통신 중 오류가 발생했습니다.'); }
}

// 📌 데이터 새로고침
function refreshData() {
    const activeToken = currentSessionToken || localStorage.getItem('sasa_sessionToken');
    if (currentStudentId && activeToken) {
        fetchPoints(currentStudentId, activeToken);
        fetchApplications(currentStudentId, activeToken);
    }
}

// 📌 로그아웃 처리
function logout() {
    disconnectAccount();
}

// 📌 REST API v1: 연동 해제
async function disconnectAccount() {
    if (!currentStudentId) return alert('현재 연동된 계정이 없습니다.');
    if (!confirm('정말 계정 연동을 해제하시겠습니까?\n저장된 자동 로그인 정보가 즉시 삭제됩니다.')) return;

    const savedToken = localStorage.getItem('sasa_sessionToken');

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/auth/disconnect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({ studentId: currentStudentId, token: savedToken })
        });

        const data = await res.json();
        if (data.success) {
            alert('계정 연동이 안전하게 해제되었습니다.');
            clearSession();
            currentStudentId = '';
            currentSessionToken = '';
            if (document.getElementById('dashboard')) document.getElementById('dashboard').style.display = 'none';
            if (document.getElementById('loginForm')) document.getElementById('loginForm').style.display = 'block';
            if (document.getElementById('studentId')) document.getElementById('studentId').value = '';
            if (document.getElementById('studentPw')) document.getElementById('studentPw').value = '';
            if (document.getElementById('rememberMe')) document.getElementById('rememberMe').checked = false;
            if (document.getElementById('rewardView')) document.getElementById('rewardView').innerText = '0';
            if (document.getElementById('penaltyView')) document.getElementById('penaltyView').innerText = '0';
            
            const rewardTbody = document.querySelector('#rewardTable tbody');
            if (rewardTbody) rewardTbody.innerHTML = '';
            const penaltyTbody = document.querySelector('#penaltyTable tbody');
            if (penaltyTbody) penaltyTbody.innerHTML = '';
            
            const studyTbody = document.querySelector('#studyHistoryTable tbody');
            if (studyTbody) studyTbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">내역을 불러오는 중...</td></tr>';
            const outTbody = document.querySelector('#outHistoryTable tbody');
            if (outTbody) outTbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">내역을 불러오는 중...</td></tr>';
            
            closeModal('studyModal');
            closeModal('outModal');
        } else { alert(data.message || '연동 해제 실패'); }
    } catch (error) { alert('서버 통신 중 오류가 발생했습니다.'); }
}

function openModal(id) { document.getElementById(id).style.display = 'block'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

// 📌 REST API v1: 신청 내역 조회 (GET 방식, 쿼리파라미터 사용)
async function fetchApplications(studentId, token) {
    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/applications?studentId=${studentId}&token=${token}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY }
        });
        
        const data = await res.json();
        if (data.success) {
            renderStudyList(data.studyList);
            renderOutList(data.outList);
        } else { console.error("신청 내역 조회 실패:", data.message); }
    } catch (error) { console.error("신청 내역 통신 오류:", error); }
}

function renderStudyList(list) {
    const tbody = document.querySelector('#studyHistoryTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:#999;">신청 내역이 없습니다.</td></tr>';
        return;
    }
    
    list.forEach(item => {
        const actionHtml = item.id 
            ? `<button onclick="deleteApplication('study', '${item.id}')" style="padding:3px 8px; background:#ff4d4f; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px;">취소</button>`
            : `<span style="color:#aaa; font-size:11px; font-weight:normal;">-</span>`;

        const tr = document.createElement('tr');
        if (item.id) tr.id = `row-study-${item.id}`; 

        tr.innerHTML = `
            <td>${item.no || ''}</td>
            <td>${formatDateTime(item.date)}</td>
            <td>${item.time || ''}</td>
            <td>${item.place || ''}</td>
            <td>${item.teacher || ''}</td>
            <td class="text-truncate" title="${item.detail || ''}">${item.detail || ''}</td>
            <td>${formatDateTime(item.applyDate)}</td>
            <td><span class="status-badge">${item.status || ''}</span></td>
            <td>${actionHtml}</td>
        `;
        tbody.appendChild(tr);
    });
}

function renderOutList(list) {
    const tbody = document.querySelector('#outHistoryTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#999;">신청 내역이 없습니다.</td></tr>';
        return;
    }
    
    list.forEach(item => {
        const actionHtml = item.id 
            ? `<button onclick="deleteApplication('out', '${item.id}')" style="padding:3px 8px; background:#ff4d4f; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px;">취소</button>`
            : `<span style="color:#999; font-size:11px; font-style:italic;">-</span>`;

        const tr = document.createElement('tr');
        if (item.id) tr.id = `row-out-${item.id}`;

        tr.innerHTML = `
            <td>${item.no || ''}</td>
            <td><strong>${item.type || ''}</strong></td>
            <td>${formatDateTime(item.outDate)}</td>
            <td>${formatDateTime(item.inDate)}</td>
            <td>${item.reason || ''}</td>
            <td>${formatDateTime(item.applyDate)}</td>
            <td><span class="status-badge">${item.status || ''}</span></td>
            <td>${actionHtml}</td>
        `;
        tbody.appendChild(tr);
    });
}

// 📌 REST API v1: 취소/삭제 대행 (DELETE 방식, 실시간 UI 제거 적용)
async function deleteApplication(type, id) {
    if (!id || id === 'undefined' || id === '') {
        alert("이 항목은 학교 시스템상 이미 확정되어 원격 취소/삭제가 불가능합니다.");
        return;
    }
    if (!confirm("정말 이 신청 내역을 원본 기숙사 사이트에서 취소/삭제하시겠습니까?")) return;

    const activeToken = currentSessionToken || localStorage.getItem('sasa_sessionToken');

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/applications/${type}/${id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({ studentId: currentStudentId, token: activeToken })
        });

        const data = await res.json();
        if (data.success) {
            alert('신청 항목이 성공적으로 삭제/취소 처리되었습니다.');
            
            const rowElement = document.getElementById(`row-${type}-${id}`);
            if (rowElement) rowElement.remove();

            const isStudy = type === 'study';
            const tableId = isStudy ? '#studyHistoryTable tbody' : '#outHistoryTable tbody';
            const colSpan = isStudy ? 9 : 8;

            const tbody = document.querySelector(tableId);
            if (tbody && tbody.children.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center; color:#999;">신청 내역이 없습니다.</td></tr>`;
            }

            setTimeout(() => { fetchApplications(currentStudentId, activeToken); }, 1000);
        } else {
            alert(data.message || '삭제 실패');
        }
    } catch (error) {
        console.error("삭제 요청 통신 에러:", error);
        alert("서버와 통신하는 중 오류가 발생했습니다.");
    }
}
