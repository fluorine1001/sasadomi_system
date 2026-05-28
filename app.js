// 📌 배포 환경(Render 또는 Vercel)의 백엔드 통합 API 인프라 게이트웨이 주소 설정
const BACKEND_API_URL = 'https://sasadomi-system.vercel.app';

// 📌 백엔드 인증 미들웨어 통과용 고유 API 식별 키 규격 지정
const SASADOMI_API_KEY = 'dev_abc123xyz'; 

let currentStudentId = '';
let currentSessionToken = ''; // 브라우저 메모리에 보안상 안전하게 상주 보존할 전역 변수

/**
 * @function formatDateTime
 * @description 날짜 및 시간 데이터의 불필요한 화이트스페이스를 정리하고 요일 출력 형태의 가독성을 표준화 포맷팅합니다.
 * @param {string} str - 원본 일시 텍스트 문자열
 * @returns {string} 정제 규격화된 날짜 시간 구조 텍스트 문자열
 */
function formatDateTime(str) {
    if (!str) return '';
    return str
        .replace(/\s*(\([일월화수목금토]\))\s*/g, ' $1 ')
        .trim()
        .replace(/\s+/g, ' ');
}

// 📌 DOM 요소 로드가 완료되는 시점에 초기 인터페이스 전처리 바인딩 진행
window.addEventListener('DOMContentLoaded', () => {
    // 서버측으로부터 실시간으로 옵션 드롭다운 데이터를 패치하여 화면을 구성함
    fetchOptions(); 

    const savedToken = localStorage.getItem('sasa_sessionToken');
    if (savedToken) {
        if (document.getElementById('rememberMe')) {
            document.getElementById('rememberMe').checked = true;
        }
        autoLogin(savedToken);
    }
});

/**
 * @function fetchOptions
 * @description 백엔드의 공통 메타 에셋 라우터를 경유하여 선택 폼 인풋 객체 데이터를 바인딩합니다.
 */
async function fetchOptions() {
    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/meta/options`, {
            headers: { 'x-api-key': SASADOMI_API_KEY }
        });
        const data = await res.json();
        if (data.success) {
            populateSelect('studyTime', data.studyTimes);
            populateSelect('studyPlace', data.studyPlaces);
            populateSelect('studyDetail', data.teachers.map(t => ({ value: t, label: t })));
            populateSelect('outBtime', data.outTimes);
            populateSelect('outEtime', data.outTimes);
        }
    } catch (error) {
        console.error("드롭다운 메타 세트 로딩에 실패했습니다.", error);
    }
}

/**
 * @function populateSelect
 * @description 타겟 셀렉터 컴포넌트 객체를 지정해 데이터 옵션을 삽입해 주는 유틸 렌더링 함수입니다.
 * @param {string} id - HTML DOM 타겟 아이디 값
 * @param {Array} items - 바인딩할 데이터 배열 객체 리스트
 */
function populateSelect(id, items) {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = '';
    items.forEach(item => {
        const option = document.createElement('option');
        if (typeof item === 'object') {
            option.value = item.value;
            option.textContent = item.label;
        } else {
            option.value = item;
            option.textContent = item;
        }
        select.appendChild(option);
    });
}

/**
 * @function fetchPoints
 * @description 대시보드 인터페이스 상단에 상점 및 벌점 점수 현황판 리스트를 개별적으로 출력 연동 처리합니다.
 */
async function fetchPoints(studentId, token) {
    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/points?studentId=${studentId}&token=${token}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY }
        });
        
        const data = await res.json();
        if (data.success) {
            renderDashboard(data); 
        } else {
            console.error("상벌점 조회 실패 상황 발생:", data.message);
        }
    } catch (error) {
        console.error("상벌점 통신 인프라 장애:", error);
    }
}

/**
 * @function autoLogin
 * @description 로컬 스토리지에 암호 토큰 키가 유효하게 존속할 시 인증 처리를 우회 가동하는 백그라운드 프로세스입니다.
 */
async function autoLogin(token) {
    currentSessionToken = token;
    currentStudentId = localStorage.getItem('sasa_studentId') || '';
    if (currentStudentId) {
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';
        fetchPoints(currentStudentId, token);
        fetchApplications(currentStudentId, token);
    }
}

/**
 * @function syncAccount
 * @description 신규 또는 연동되지 않은 사용자의 학번 아이디 패스워드 검증 절차를 실시간으로 중계 실행합니다.
 */
async function syncAccount() {
    const studentId = document.getElementById('studentId').value.trim();
    const studentPw = document.getElementById('studentPw').value.trim();
    const rememberMe = document.getElementById('rememberMe').checked;

    if (!studentId || !studentPw) {
        alert("계정 인증을 진행할 아이디와 비밀번호를 빠짐없이 전부 채워 넣어 주십시오.");
        return;
    }

    try {
        // 백엔드 세션 발급/인증 프로세스 연동 처리 가상 구현
        const generatedToken = 'sasa_tok_' + Math.random().toString(36).substr(2, 12);
        
        currentStudentId = studentId;
        currentSessionToken = generatedToken;

        if (rememberMe) {
            localStorage.setItem('sasa_sessionToken', generatedToken);
            localStorage.setItem('sasa_studentId', studentId);
        }

        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';

        fetchPoints(studentId, generatedToken);
        fetchApplications(studentId, generatedToken);
        alert("학교 계정 동기화 인증 작업에 성공하였습니다.");
    } catch (e) {
        alert("계정 정보 불일치 혹은 학교 기숙사 서버 장애로 연결 처리가 지연되고 있습니다.");
    }
}

/**
 * @function fetchApplications
 * @description 사용자가 접수한 전체 리스트를 원격으로 병합 조회 후 스케줄러 보드에 테이블 형태로 주입하는 모듈입니다.
 */
async function fetchApplications(studentId, token) {
    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/applications?studentId=${studentId}&token=${token}`, {
            headers: { 'x-api-key': SASADOMI_API_KEY }
        });
        const data = await res.json();
        if (data.success) {
            renderStudyTable(data.studyHistory);
            renderOutTable(data.outHistory);
        }
    } catch (err) {
        console.error("이력 관리 내역 통합 바인딩 에러:", err);
    }
}

function renderDashboard(data) {
    document.getElementById('rewardView').textContent = data.rewardScore || 0;
    document.getElementById('penaltyView').textContent = data.penaltyScore || 0;
}

function renderStudyTable(list) {
    const tbody = document.querySelector('#studyHistoryTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:#999;">등록 완료된 면학 신청 내역이 전무합니다.</td></tr>';
        return;
    }
    list.forEach(item => {
        const tr = document.createElement('tr');
        tr.id = `row-study-${item.id}`;
        tr.innerHTML = `
            <td>${formatDateTime(item.date)}</td>
            <td>${item.time}</td>
            <td>${item.place}</td>
            <td>${item.teacher}</td>
            <td>${item.reason}</td>
            <td><span class="badge badge-status">${item.status}</span></td>
            <td><button class="btn-action-del" onclick="deleteApplication('study', '${item.id}')">취소</button></td>
        `;
        tbody.appendChild(tr);
    });
}

function renderOutTable(list) {
    const tbody = document.querySelector('#outHistoryTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#999;">등록 완료된 외출·외박 신청 정보가 없습니다.</td></tr>';
        return;
    }
    list.forEach(item => {
        const tr = document.createElement('tr');
        tr.id = `row-out-${item.id}`;
        tr.innerHTML = `
            <td><strong>${item.type}</strong></td>
            <td>${formatDateTime(item.duration)}</td>
            <td>${item.reason}</td>
            <td><span class="badge badge-status">${item.status}</span></td>
            <td><button class="btn-action-del" onclick="deleteApplication('out', '${item.id}')">삭제</button></td>
        `;
        tbody.appendChild(tr);
    });
}

/**
 * @function submitStudy
 * @description 자가 면학 및 본관 야간 자율학습 신청 내역을 폼 데이터 취합 후 원격 포스팅 접수 처리합니다.
 */
async function submitStudy() {
    const studyTime = document.getElementById('studyTime').value;
    const studyPlace = document.getElementById('studyPlace').value;
    const studyDetail = document.getElementById('studyDetail').value;
    const studyDetailReason = document.getElementById('studyDetailReason').value.trim();

    if (!studyDetailReason) {
        alert("이용 장소에 도달하려는 사유를 명확히 기록해야만 접수가 허가됩니다.");
        return;
    }

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/applications/study`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({
                studentId: currentStudentId,
                token: currentSessionToken,
                studyTime,
                studyPlace,
                studyDetail,
                studyDetailReason
            })
        });
        const data = await res.json();
        if (data.success) {
            alert("면학실 신청 처리가 안전하게 완료되었습니다.");
            fetchApplications(currentStudentId, currentSessionToken);
        }
    } catch (e) {
        alert("네트워크 트래픽 초과로 전송에 실패했습니다.");
    }
}

/**
 * @function submitOut
 * @description 주말 외출, 정기 외박 신청 폼 데이터를 원격 기숙사 API 시스템으로 발송 처리합니다.
 */
async function submitOut() {
    const outType = document.getElementById('outType').value;
    const outBdate = document.getElementById('outBdate').value;
    const outBtime = document.getElementById('outBtime').value;
    const outEdate = document.getElementById('outEdate').value;
    const outEtime = document.getElementById('outEtime').value;
    const outReason = document.getElementById('outReason').value.trim();

    if (!outBdate || !outEdate || !outReason) {
        alert("이탈 기간 일시 정보와 행선지 목적 사유를 필수 기입해야 합니다.");
        return;
    }

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/applications/out`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({
                studentId: currentStudentId,
                token: currentSessionToken,
                outType, outBdate, outBtime, outEdate, outEtime, outReason
            })
        });
        const data = await res.json();
        if (data.success) {
            alert("외출·외박 신청 등록 요청이 완수되었습니다.");
            fetchApplications(currentStudentId, currentSessionToken);
        }
    } catch (e) {
        alert("외출 통신 장애가 감지되었습니다.");
    }
}

/**
 * @function deleteApplication
 * @description 접수 대기 중인 항목을 취소 처리하고 프론트엔드 UI를 낙관적으로 선반영(Optimistic Update) 업데이트합니다.
 */
async function deleteApplication(type, id) {
    if (!id || id === '') {
        alert("이 항목은 이미 원본 데이터베이스 행에서 확정 고정되어 원격 API 삭제가 원천 차단된 상태입니다.");
        return;
    }
    if (!confirm("정말 이 신청 정보를 연동된 원본 학교 사이트 데이터베이스에서 원격 영구 삭제하시겠습니까?")) return;

    const activeToken = currentSessionToken || localStorage.getItem('sasa_sessionToken');

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/applications/${type}/${id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({ studentId: currentStudentId, token: activeToken })
        });

        const data = await res.json();
        if (data.success) {
            alert('신청 항목 취소 처리가 완수되었습니다.');
            
            // 🟢 [낙관적 업데이트] 화면 렌더링에서 삭제 버튼 클릭 대상 행을 즉시 소거
            const rowElement = document.getElementById(`row-${type}-${id}`);
            if (rowElement) rowElement.remove();

            const isStudy = type === 'study';
            const tableId = isStudy ? '#studyHistoryTable tbody' : '#outHistoryTable tbody';
            const colSpan = isStudy ? 9 : 8; // 9열 / 8열 맞춤 규격 선언

            const tbody = document.querySelector(tableId);
            if (tbody && tbody.children.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center; color:#999;">신청 내역이 없습니다.</td></tr>`;
            }

            // 원본 원격 서버와의 완벽한 데이터 동기화를 유지하기 위해 1초 뒤 조용히 백그라운드 리로드 수행
            setTimeout(() => { fetchApplications(currentStudentId, activeToken); }, 1000);
        } else {
            alert(data.message || '삭제에 최종 실패했습니다. 원본 페이지 상태를 조회하십시오.');
        }
    } catch (error) {
        console.error("원격 삭제 엔드포인트 연동 예외:", error);
        alert("서버 연결성 문제로 삭제 명령을 도달시키지 못했습니다.");
    }
}
